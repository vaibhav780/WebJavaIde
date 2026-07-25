const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// Disable caching for IDE static assets
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    next();
});

app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

function getSystemJdkPath() {
    const isWin = process.platform === 'win32';
    const javacName = isWin ? 'javac.exe' : 'javac';

    // 1. Check JAVA_HOME
    if (process.env.JAVA_HOME && fs.existsSync(process.env.JAVA_HOME)) {
        const javacPath = path.join(process.env.JAVA_HOME, 'bin', javacName);
        if (fs.existsSync(javacPath)) {
            return process.env.JAVA_HOME;
        }
    }

    // 2. Check standard Java installation directories
    if (isWin) {
        const javaProgramFiles = 'C:\\Program Files\\Java';
        if (fs.existsSync(javaProgramFiles)) {
            try {
                const entries = fs.readdirSync(javaProgramFiles);
                for (const entry of entries) {
                    const candidate = path.join(javaProgramFiles, entry);
                    if (fs.existsSync(path.join(candidate, 'bin', javacName))) {
                        return candidate;
                    }
                }
            } catch (e) {}
        }
    } else {
        const candidateDirs = ['/usr/lib/jvm/default-java', '/usr/lib/jvm/java-17-openjdk', '/Library/Java/JavaVirtualMachines'];
        for (const cand of candidateDirs) {
            if (fs.existsSync(path.join(cand, 'bin', javacName))) {
                return cand;
            }
        }
    }

    // 3. Search PATH
    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    for (const dir of pathDirs) {
        const javacExecutable = path.join(dir, javacName);
        if (fs.existsSync(javacExecutable)) {
            if (path.basename(dir) === 'bin') {
                return path.dirname(dir);
            }
        }
    }
    return '';
}

function getBinaries(userJdk) {
    const isWin = process.platform === 'win32';
    const javacName = isWin ? 'javac.exe' : 'javac';
    const javaName = isWin ? 'java.exe' : 'java';
    const jdbName = isWin ? 'jdb.exe' : 'jdb';

    const jdkPath = userJdk && userJdk.trim() ? userJdk.trim() : getSystemJdkPath();

    if (jdkPath) {
        const javacBin = path.join(jdkPath, 'bin', javacName);
        const javaBin = path.join(jdkPath, 'bin', javaName);
        const jdbBin = path.join(jdkPath, 'bin', jdbName);
        if (fs.existsSync(javacBin) && fs.existsSync(javaBin)) {
            return { javacBin, javaBin, jdbBin, jdkPath, valid: true };
        }
    }

    return {
        javacBin: javacName,
        javaBin: javaName,
        jdbBin: jdbName,
        jdkPath: '',
        valid: false
    };
}

function resolveMainClass(files, defaultMainClass) {
    for (const file of files) {
        if (!file || !file.content) continue;
        const content = file.content;
        if (content.includes('static void main') || content.includes('static public void main')) {
            let packageName = '';
            const pkgMatch = content.match(/package\s+([\w\.]+)\s*;/);
            if (pkgMatch) {
                packageName = pkgMatch[1];
            }

            let className = '';
            const classMatch = content.match(/public\s+class\s+(\w+)/) || content.match(/class\s+(\w+)/);
            if (classMatch) {
                className = classMatch[1];
            }

            if (className) {
                return packageName ? `${packageName}.${className}` : className;
            }
        }
    }
    return defaultMainClass || 'Main';
}

app.get('/api/jdk-path', (req, res) => {
    res.json({ jdkPath: getSystemJdkPath() || '' });
});

function setupWorkspace(files, workspaceDir) {
    try {
        if (!fs.existsSync(workspaceDir)) {
            fs.mkdirSync(workspaceDir, { recursive: true });
        }
    } catch (e) {
        console.error("Error creating workspace directory:", e);
    }

    const javaFiles = [];
    for (const file of files) {
        if (!file || !file.path) continue;
        const fullPath = path.join(workspaceDir, file.path);
        const dirName = path.dirname(fullPath);
        try {
            if (!fs.existsSync(dirName)) fs.mkdirSync(dirName, { recursive: true });
            fs.writeFileSync(fullPath, file.content || '');
            if ((file.name && file.name.endsWith('.java')) || file.path.endsWith('.java')) {
                javaFiles.push(fullPath);
            }
        } catch (writeErr) {
            console.error("Error writing workspace file:", fullPath, writeErr);
        }
    }
    return javaFiles;
}

// HTTP Fallback Endpoint for non-WebSocket or blocked environments
app.post('/api/run', (req, res) => {
    try {
        const { files, mainClass: userMainClass, jdkPath: userJdk } = req.body;
        const { javacBin, javaBin, valid } = getBinaries(userJdk);
        
        if (userJdk && userJdk.trim() && !valid) {
            return res.json({ success: false, output: `JDK Error: Executables (javac/java) not found at "${userJdk}".` });
        }

        const tempDir = path.join(__dirname, 'temp_workspace');
        const javaFiles = setupWorkspace(files, tempDir);
        const targetMainClass = resolveMainClass(files, userMainClass);

        if (javaFiles.length === 0) {
            return res.json({ success: false, output: 'No Java files found to compile.' });
        }

        const compileArgs = ['-d', tempDir, ...javaFiles];
        execFile(javacBin, compileArgs, (compileErr, stdout, stderr) => {
            if (compileErr) {
                return res.json({ success: false, output: `Compilation Error:\n${stderr || stdout || compileErr.message}` });
            }

            execFile(javaBin, ['-cp', tempDir, targetMainClass], { timeout: 15000 }, (runErr, runStdout, runStderr) => {
                let combinedOutput = (stdout ? stdout + '\n' : '') + (runStdout || '');
                if (runErr && runErr.killed) {
                    return res.json({ success: true, output: combinedOutput + '\n[Process timed out - interactive prompt requires WebSocket terminal]' });
                }
                if (runErr) {
                    return res.json({ success: false, output: combinedOutput + '\n' + (runStderr || runErr.message) });
                }
                res.json({ success: true, output: combinedOutput });
            });
        });
    } catch (e) {
        res.status(500).json({ success: false, output: `Server Error: ${e.message}` });
    }
});

// WebSocket Router
wss.on('connection', (ws) => {
    ws.runningAppProcess = null;
    ws.runningJdbProcess = null;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            // --- 1. RUN INTERACTIVE PROGRAM VIA XTERM.JS ---
            if (data.type === 'run_interactive') {
                const { files, mainClass: userMainClass, jdkPath: userJdk } = data;
                
                if (ws.runningAppProcess) {
                    try { ws.runningAppProcess.kill('SIGKILL'); } catch (e) {}
                    ws.runningAppProcess = null;
                }
                if (ws.runningJdbProcess) {
                    try { ws.runningJdbProcess.kill('SIGKILL'); } catch (e) {}
                    ws.runningJdbProcess = null;
                }

                const { javacBin, javaBin, valid } = getBinaries(userJdk);
                
                if (userJdk && userJdk.trim() && !valid) {
                    ws.send(JSON.stringify({
                        type: 'output',
                        data: `\r\n\x1b[31mJDK Error: Executables (javac/java) not found at "${userJdk}". Please check path.\x1b[0m\r\n`
                    }));
                    return;
                }

                const tempDir = path.join(__dirname, 'temp_workspace');
                const javaFiles = setupWorkspace(files, tempDir);
                const targetMainClass = resolveMainClass(files, userMainClass);

                if (javaFiles.length === 0) {
                    ws.send(JSON.stringify({ type: 'output', data: '\r\n\x1b[31mNo Java files found to compile.\x1b[0m\r\n' }));
                    return;
                }

                ws.send(JSON.stringify({ type: 'output', data: '\r\n\x1b[33mCompiling project...\x1b[0m\r\n' }));

                const compileArgs = ['-d', tempDir, ...javaFiles];
                execFile(javacBin, compileArgs, (err, stdout, stderr) => {
                    if (err) {
                        const errorMsg = stderr || stdout || err.message;
                        ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[31mCompilation Error:\r\n${errorMsg.replace(/\n/g, '\r\n')}\x1b[0m\r\n` }));
                        return;
                    }

                    if (stderr && stderr.trim()) {
                        ws.send(JSON.stringify({ type: 'output', data: `\x1b[33m${stderr.replace(/\n/g, '\r\n')}\x1b[0m\r\n` }));
                    }

                    ws.send(JSON.stringify({ type: 'output', data: `\x1b[32mCompilation successful. Launching ${targetMainClass}...\x1b[0m\r\n\r\n` }));

                    ws.runningAppProcess = spawn(javaBin, ['-cp', tempDir, targetMainClass]);

                    ws.runningAppProcess.stdout.on('data', (d) => {
                        ws.send(JSON.stringify({ type: 'output', data: d.toString().replace(/\n/g, '\r\n') }));
                    });

                    ws.runningAppProcess.stderr.on('data', (d) => {
                        ws.send(JSON.stringify({ type: 'output', data: d.toString().replace(/\n/g, '\r\n') }));
                    });

                    ws.runningAppProcess.on('exit', (code) => {
                        ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[90m[Process exited with code ${code !== null ? code : 0}]\x1b[0m\r\n` }));
                        ws.runningAppProcess = null;
                    });

                    ws.runningAppProcess.on('error', (procErr) => {
                        ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[31mFailed to start Java process: ${procErr.message}\x1b[0m\r\n` }));
                        ws.runningAppProcess = null;
                    });
                });
            }

            // Forward user inputs from xterm.js to process Stdin
            if (data.type === 'terminal_input') {
                if (ws.runningAppProcess && ws.runningAppProcess.stdin && ws.runningAppProcess.stdin.writable) {
                    const echo = data.input === '\r' ? '\r\n' : (data.input === '\x7f' ? '\b \b' : data.input);
                    ws.send(JSON.stringify({ type: 'output', data: echo }));

                    const inputToSend = data.input.replace(/\r/g, '\n');
                    ws.runningAppProcess.stdin.write(inputToSend);
                } else if (ws.runningJdbProcess && ws.runningJdbProcess.stdin && ws.runningJdbProcess.stdin.writable) {
                    const echo = data.input === '\r' ? '\r\n' : (data.input === '\x7f' ? '\b \b' : data.input);
                    ws.send(JSON.stringify({ type: 'output', data: echo }));

                    const inputToSend = data.input.replace(/\r/g, '\n');
                    ws.runningJdbProcess.stdin.write(inputToSend);
                }
            }

            // --- 2. VISUAL DEBUGGER VIA JDB ---
            if (data.type === 'debug_start') {
                const { files, mainClass: userMainClass, breakpoints, jdkPath: userJdk } = data;
                
                if (ws.runningAppProcess) {
                    try { ws.runningAppProcess.kill('SIGKILL'); } catch (e) {}
                    ws.runningAppProcess = null;
                }
                if (ws.runningJdbProcess) {
                    try { ws.runningJdbProcess.kill('SIGKILL'); } catch (e) {}
                    ws.runningJdbProcess = null;
                }

                const { javacBin, jdbBin, valid } = getBinaries(userJdk);
                
                if (userJdk && userJdk.trim() && !valid) {
                    ws.send(JSON.stringify({
                        type: 'output',
                        data: `\r\n\x1b[31mJDK Error: Executables (javac/jdb) not found at "${userJdk}". Please check path.\x1b[0m\r\n`
                    }));
                    return;
                }

                const tempDir = path.join(__dirname, 'temp_workspace');
                const javaFiles = setupWorkspace(files, tempDir);
                const targetMainClass = resolveMainClass(files, userMainClass);

                ws.send(JSON.stringify({ type: 'output', data: '\r\n\x1b[33mCompiling with debug symbols (-g)...\x1b[0m\r\n' }));

                const compileArgs = ['-g', '-d', tempDir, ...javaFiles];
                execFile(javacBin, compileArgs, (err, stdout, stderr) => {
                    if (err) {
                        const errorMsg = stderr || stdout || err.message;
                        ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[31mCompile Error:\r\n${errorMsg.replace(/\n/g, '\r\n')}\x1b[0m\r\n` }));
                        return;
                    }

                    ws.runningJdbProcess = spawn(jdbBin, ['-classpath', tempDir, targetMainClass]);

                    ws.runningJdbProcess.stdout.on('data', (d) => {
                        const str = d.toString();
                        ws.send(JSON.stringify({ type: 'output', data: str.replace(/\n/g, '\r\n') }));

                        if (str.includes('Breakpoint hit:') || str.includes('Step completed:')) {
                            const lineMatch = str.match(/line=(\d+)/);
                            const classMatch = str.match(/thread=.*?, ([\w\.]+)\./);
                            
                            if (ws.runningJdbProcess && ws.runningJdbProcess.stdin) {
                                ws.runningJdbProcess.stdin.write('locals\n');
                                ws.runningJdbProcess.stdin.write('where\n');
                            }

                            ws.send(JSON.stringify({
                                type: 'debug_event',
                                event: 'stopped',
                                line: lineMatch ? parseInt(lineMatch[1]) : null,
                                className: classMatch ? classMatch[1] : targetMainClass,
                                raw: str
                            }));
                        }

                        if (str.includes('Local variables:')) {
                            ws.send(JSON.stringify({ type: 'debug_vars', data: str }));
                        }
                    });

                    ws.runningJdbProcess.on('exit', (code) => {
                        ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[90m[Debugger process exited with code ${code !== null ? code : 0}]\x1b[0m\r\n` }));
                        ws.runningJdbProcess = null;
                    });

                    setTimeout(() => {
                        if (ws.runningJdbProcess && ws.runningJdbProcess.stdin) {
                            (breakpoints || []).forEach(bp => {
                                ws.runningJdbProcess.stdin.write(`stop at ${bp.className}:${bp.lineNumber}\n`);
                            });
                            ws.runningJdbProcess.stdin.write('run\n');
                        }
                    }, 1000);
                });
            }

            // Debugger Command Execution
            if (data.type === 'debug_command') {
                if (ws.runningJdbProcess && ws.runningJdbProcess.stdin && ws.runningJdbProcess.stdin.writable) {
                    ws.runningJdbProcess.stdin.write(`${data.command}\n`);
                }
            }

        } catch (e) {
            console.error("WebSocket Message Error:", e);
            try {
                ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[31mServer Error: ${e.message}\x1b[0m\r\n` }));
            } catch (ignore) {}
        }
    });

    ws.on('close', () => {
        if (ws.runningAppProcess) {
            try { ws.runningAppProcess.kill('SIGKILL'); } catch (e) {}
        }
        if (ws.runningJdbProcess) {
            try { ws.runningJdbProcess.kill('SIGKILL'); } catch (e) {}
        }
    });
});

server.listen(3000, () => console.log('Interactive Java IDE + Debugger running on http://localhost:3000'));