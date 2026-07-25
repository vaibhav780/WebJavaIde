const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parseStringPromise } = require('xml2js');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const JUNIT_JAR = path.join(__dirname, 'lib', 'junit-platform-console-standalone-1.10.2.jar');

function getSystemJdkPath() {
    if (process.env.JAVA_HOME && fs.existsSync(process.env.JAVA_HOME)) {
        return process.env.JAVA_HOME;
    }
    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    for (const dir of pathDirs) {
        const javacExecutable = path.join(dir, process.platform === 'win32' ? 'javac.exe' : 'javac');
        if (fs.existsSync(javacExecutable)) {
            return path.dirname(dir);
        }
    }
    return null;
}

app.get('/api/jdk-path', (req, res) => {
    res.json({ jdkPath: getSystemJdkPath() || '' });
});

function setupWorkspace(files, workspaceDir) {
    if (fs.existsSync(workspaceDir)) fs.rmSync(workspaceDir, { recursive: true, force: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    const javaFiles = [];
    for (const file of files) {
        const fullPath = path.join(workspaceDir, file.path);
        const dirName = path.dirname(fullPath);
        if (!fs.existsSync(dirName)) fs.mkdirSync(dirName, { recursive: true });
        fs.writeFileSync(fullPath, file.content);
        if (file.name.endsWith('.java')) javaFiles.push(fullPath);
    }
    return javaFiles;
}

// Global process references for WebSocket sessions
let runningAppProcess = null;
let runningJdbProcess = null;

// WebSocket Router
wss.on('connection', (ws) => {
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            // --- 1. RUN INTERACTIVE PROGRAM VIA XTERM.JS ---
            if (data.type === 'run_interactive') {
                const { files, mainClass, jdkPath: userJdk } = data;
                const jdkPath = userJdk || getSystemJdkPath();
                const tempDir = path.join(__dirname, 'temp_workspace');
                const javaFiles = setupWorkspace(files, tempDir);

                const isWin = process.platform === 'win32';
                const javacBin = path.join(jdkPath, 'bin', isWin ? 'javac.exe' : 'javac');
                const javaBin = path.join(jdkPath, 'bin', isWin ? 'java.exe' : 'java');

                ws.send(JSON.stringify({ type: 'output', data: '\r\n\x1b[33mCompiling project...\x1b[0m\r\n' }));

                const javaFilesArg = javaFiles.map(f => `"${f}"`).join(' ');
                exec(`"${javacBin}" -d "${tempDir}" ${javaFilesArg}`, (err, stdout, stderr) => {
                    if (err || stderr) {
                        ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[31mCompilation Error:\r\n${stderr || err.message}\x1b[0m\r\n` }));
                        return;
                    }

                    ws.send(JSON.stringify({ type: 'output', data: `\x1b[32mCompilation successful. Launching ${mainClass}...\x1b[0m\r\n\r\n` }));

                    if (runningAppProcess) runningAppProcess.kill();
                    runningAppProcess = spawn(javaBin, ['-cp', tempDir, mainClass]);

                    runningAppProcess.stdout.on('data', (d) => ws.send(JSON.stringify({ type: 'output', data: d.toString().replace(/\n/g, '\r\n') })));
                    runningAppProcess.stderr.on('data', (d) => ws.send(JSON.stringify({ type: 'output', data: d.toString().replace(/\n/g, '\r\n') })));

                    runningAppProcess.on('exit', (code) => {
                        ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[90m[Process exited with code ${code}]\x1b[0m\r\n` }));
                        runningAppProcess = null;
                    });
                });
            }

            // Forward user inputs from xterm.js to process Stdin
            if (data.type === 'terminal_input') {
                if (runningAppProcess && runningAppProcess.stdin) {
                    runningAppProcess.stdin.write(data.input);
                }
            }

            // --- 2. VISUAL DEBUGGER VIA JDB ---
            if (data.type === 'debug_start') {
                const { files, mainClass, breakpoints, jdkPath: userJdk } = data;
                const jdkPath = userJdk || getSystemJdkPath();
                const tempDir = path.join(__dirname, 'temp_workspace');
                const javaFiles = setupWorkspace(files, tempDir);

                const isWin = process.platform === 'win32';
                const javacBin = path.join(jdkPath, 'bin', isWin ? 'javac.exe' : 'javac');
                const jdbBin = path.join(jdkPath, 'bin', isWin ? 'jdb.exe' : 'jdb');

                ws.send(JSON.stringify({ type: 'output', data: '\r\n\x1b[33mCompiling with debug symbols (-g)...\x1b[0m\r\n' }));

                const javaFilesArg = javaFiles.map(f => `"${f}"`).join(' ');
                // Compile with -g flag for debug symbols
                exec(`"${javacBin}" -g -d "${tempDir}" ${javaFilesArg}`, (err, stdout, stderr) => {
                    if (err || stderr) {
                        ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[31mCompile Error:\r\n${stderr}\x1b[0m\r\n` }));
                        return;
                    }

                    if (runningJdbProcess) runningJdbProcess.kill();
                    runningJdbProcess = spawn(jdbBin, ['-classpath', tempDir, mainClass]);

                    runningJdbProcess.stdout.on('data', (d) => {
                        const str = d.toString();
                        ws.send(JSON.stringify({ type: 'output', data: str.replace(/\n/g, '\r\n') }));

                        // Detect breakpoint hit or step event
                        if (str.includes('Breakpoint hit:') || str.includes('Step completed:')) {
                            const lineMatch = str.match(/line=(\d+)/);
                            const classMatch = str.match(/thread=.*?, ([\w\.]+)\./);
                            
                            // Query debugger for variables and stack frames
                            runningJdbProcess.stdin.write('locals\n');
                            runningJdbProcess.stdin.write('where\n');

                            ws.send(JSON.stringify({
                                type: 'debug_event',
                                event: 'stopped',
                                line: lineMatch ? parseInt(lineMatch[1]) : null,
                                className: classMatch ? classMatch[1] : mainClass,
                                raw: str
                            }));
                        }

                        // Parse locals output
                        if (str.includes('Local variables:')) {
                            ws.send(JSON.stringify({ type: 'debug_vars', data: str }));
                        }
                    });

                    // Set requested breakpoints immediately upon launching JDB
                    setTimeout(() => {
                        breakpoints.forEach(bp => {
                            runningJdbProcess.stdin.write(`stop at ${bp.className}:${bp.lineNumber}\n`);
                        });
                        runningJdbProcess.stdin.write('run\n');
                    }, 1000);
                });
            }

            // Debugger Command Execution
            if (data.type === 'debug_command') {
                if (runningJdbProcess && runningJdbProcess.stdin) {
                    // Send JDB commands: 'cont', 'step', 'next'
                    runningJdbProcess.stdin.write(`${data.command}\n`);
                }
            }

        } catch (e) {
            console.error("WebSocket Message Error:", e);
        }
    });
});

server.listen(3000, () => console.log('Interactive Java IDE + Debugger running on http://localhost:3000'));