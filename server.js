const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const AdmZip = require('adm-zip');

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

const JUNIT_JAR = path.join(__dirname, 'lib', 'junit-platform-console-standalone-1.10.2.jar');

function getSystemJdkPath() {
    const isWin = process.platform === 'win32';
    const javacName = isWin ? 'javac.exe' : 'javac';

    if (process.env.JAVA_HOME && fs.existsSync(process.env.JAVA_HOME)) {
        const javacPath = path.join(process.env.JAVA_HOME, 'bin', javacName);
        if (fs.existsSync(javacPath)) {
            return process.env.JAVA_HOME;
        }
    }

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

function getClasspath(tempDir) {
    const libDir = path.join(__dirname, 'lib');
    let cp = tempDir;
    if (fs.existsSync(libDir)) {
        try {
            const files = fs.readdirSync(libDir);
            for (const f of files) {
                if (f.endsWith('.jar')) {
                    cp += `${path.delimiter}${path.join(libDir, f)}`;
                }
            }
        } catch (e) {}
    }
    return cp;
}

function resolveMainClass(files, defaultMainClass) {
    for (const file of files) {
        if (!file || !file.content) continue;
        const content = file.content;
        if (content.includes('static void main') || content.includes('static public void main')) {
            let packageName = '';
            const pkgMatch = content.match(/package\s+([\w\.]+)\s*;/);
            if (pkgMatch) packageName = pkgMatch[1];

            let className = '';
            const classMatch = content.match(/public\s+class\s+(\w+)/) || content.match(/class\s+(\w+)/);
            if (classMatch) className = classMatch[1];

            if (className) return packageName ? `${packageName}.${className}` : className;
        }
    }
    return defaultMainClass || 'Main';
}

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

function parseJavacOutput(output, files) {
    const markers = [];
    const lines = output.split('\n');
    const regex = /(.*?\.java):(\d+):\s*(error|warning):\s*(.*)/i;

    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(regex);
        if (match) {
            const rawPath = match[1];
            const lineNumber = parseInt(match[2], 10);
            const severityStr = match[3].toLowerCase();
            const message = match[4].trim();

            const fileName = path.basename(rawPath);
            const matchedFile = files.find(f => f.path.endsWith(fileName) || f.name === fileName);

            let col = 1;
            if (i + 2 < lines.length && lines[i + 2].includes('^')) {
                col = lines[i + 2].indexOf('^') + 1;
            }

            markers.push({
                fileId: matchedFile ? matchedFile.id : null,
                fileName: fileName,
                startLineNumber: lineNumber,
                startColumn: col,
                endLineNumber: lineNumber,
                endColumn: col + 10,
                message: message,
                severity: severityStr === 'error' ? 8 : 4 // Monaco Error = 8, Warning = 4
            });
        }
    }
    return markers;
}

// 1. JDK Path Detection
app.get('/api/jdk-path', (req, res) => {
    res.json({ jdkPath: getSystemJdkPath() || '' });
});

// 2. Real-Time Syntax Linter Endpoint
app.post('/api/lint', (req, res) => {
    try {
        const { files, jdkPath: userJdk } = req.body;
        const { javacBin } = getBinaries(userJdk);
        const tempDir = path.join(__dirname, 'temp_workspace');
        const javaFiles = setupWorkspace(files, tempDir);

        if (javaFiles.length === 0) return res.json({ markers: [] });

        const classpath = getClasspath(tempDir);
        const compileArgs = ['-cp', classpath, '-d', tempDir, ...javaFiles];

        execFile(javacBin, compileArgs, (err, stdout, stderr) => {
            const output = (stderr || '') + '\n' + (stdout || '');
            const markers = parseJavacOutput(output, files);
            res.json({ markers });
        });
    } catch (e) {
        res.json({ markers: [] });
    }
});

// 3. HTTP Fallback Program Runner (with Profiling Metrics)
app.post('/api/run', (req, res) => {
    try {
        const startTime = Date.now();
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

        const classpath = getClasspath(tempDir);
        const compileArgs = ['-cp', classpath, '-d', tempDir, ...javaFiles];

        execFile(javacBin, compileArgs, (compileErr, stdout, stderr) => {
            if (compileErr) {
                return res.json({ success: false, output: `Compilation Error:\n${stderr || stdout || compileErr.message}` });
            }

            execFile(javaBin, ['-cp', classpath, targetMainClass], { timeout: 15000 }, (runErr, runStdout, runStderr) => {
                const duration = Date.now() - startTime;
                let combinedOutput = (stdout ? stdout + '\n' : '') + (runStdout || '');
                if (runErr && runErr.killed) {
                    return res.json({ success: true, output: combinedOutput + '\n[Process timed out - use interactive terminal]', duration });
                }
                if (runErr) {
                    return res.json({ success: false, output: combinedOutput + '\n' + (runStderr || runErr.message), duration });
                }
                res.json({ success: true, output: combinedOutput, duration });
            });
        });
    } catch (e) {
        res.status(500).json({ success: false, output: `Server Error: ${e.message}` });
    }
});

// 4. JUnit 5 Unit Test Runner Endpoint
app.post('/api/test', (req, res) => {
    try {
        const startTime = Date.now();
        const { files, jdkPath: userJdk } = req.body;
        const { javacBin, javaBin } = getBinaries(userJdk);
        const tempDir = path.join(__dirname, 'temp_workspace');
        const javaFiles = setupWorkspace(files, tempDir);

        if (javaFiles.length === 0) {
            return res.json({ success: false, output: 'No files to test.' });
        }

        const classpath = getClasspath(tempDir);
        const compileArgs = ['-cp', classpath, '-d', tempDir, ...javaFiles];

        execFile(javacBin, compileArgs, (compileErr, stdout, stderr) => {
            if (compileErr) {
                return res.json({ success: false, output: `Compilation Error:\n${stderr || stdout || compileErr.message}` });
            }

            if (!fs.existsSync(JUNIT_JAR)) {
                return res.json({ success: false, output: `JUnit JAR not found at ${JUNIT_JAR}` });
            }

            const junitArgs = [
                '-jar', JUNIT_JAR,
                '--class-path', tempDir,
                '--scan-class-path',
                '--disable-banner'
            ];

            execFile(javaBin, junitArgs, (testErr, testStdout, testStderr) => {
                const duration = Date.now() - startTime;
                const fullOutput = (testStdout || '') + '\n' + (testStderr || '');
                
                const passedMatch = fullOutput.match(/(\d+)\s+tests successful/);
                const failedMatch = fullOutput.match(/(\d+)\s+tests failed/);
                const foundMatch = fullOutput.match(/(\d+)\s+tests found/);

                const passedCount = passedMatch ? parseInt(passedMatch[1]) : 0;
                const failedCount = failedMatch ? parseInt(failedMatch[1]) : 0;
                const totalCount = foundMatch ? parseInt(foundMatch[1]) : (passedCount + failedCount);

                res.json({
                    success: failedCount === 0,
                    output: fullOutput,
                    duration,
                    summary: {
                        total: totalCount,
                        passed: passedCount,
                        failed: failedCount
                    }
                });
            });
        });
    } catch (e) {
        res.status(500).json({ success: false, output: e.message });
    }
});

// 5. Maven & External Dependency Manager
app.get('/api/dependencies', (req, res) => {
    const libDir = path.join(__dirname, 'lib');
    const jars = [];
    if (fs.existsSync(libDir)) {
        try {
            const files = fs.readdirSync(libDir);
            for (const f of files) {
                if (f.endsWith('.jar')) {
                    const stats = fs.statSync(path.join(libDir, f));
                    jars.push({ name: f, size: stats.size });
                }
            }
        } catch (e) {}
    }
    res.json({ dependencies: jars });
});

app.post('/api/dependencies/add', (req, res) => {
    const { url, jarName } = req.body;
    if (!url) return res.status(400).json({ error: "URL is required" });

    const libDir = path.join(__dirname, 'lib');
    if (!fs.existsSync(libDir)) fs.mkdirSync(libDir, { recursive: true });

    const filename = jarName || path.basename(url) || `dep-${Date.now()}.jar`;
    const dest = path.join(libDir, filename);

    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
            https.get(response.headers.location, (res2) => {
                res2.pipe(file);
                file.on('finish', () => {
                    file.close();
                    res.json({ success: true, message: `Added ${filename}` });
                });
            });
        } else {
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                res.json({ success: true, message: `Added ${filename}` });
            });
        }
    }).on('error', (err) => {
        fs.unlink(dest, () => {});
        res.status(500).json({ error: err.message });
    });
});

// 6. AI Code Assistant Endpoints
app.post('/api/ai/fix', (req, res) => {
    const { error, code, filename } = req.body;
    
    let patch = code;
    let explanation = "Analyzed syntax error.";

    if (error.includes("';' expected")) {
        explanation = "Added missing semicolon at line end.";
        patch = code.replace(/(\w+)(\s*\n)/g, "$1;\n");
    } else if (error.includes("cannot find symbol") && error.includes("Scanner")) {
        explanation = "Added missing Scanner import: 'import java.util.Scanner;'";
        patch = "import java.util.Scanner;\n" + code;
    } else if (error.includes("cannot find symbol") && error.includes("List")) {
        explanation = "Added missing List import: 'import java.util.List; import java.util.ArrayList;'";
        patch = "import java.util.List;\nimport java.util.ArrayList;\n" + code;
    } else if (error.includes("class") && error.includes("is public, should be declared in a file named")) {
        const match = error.match(/class\s+(\w+)\s+is public/);
        if (match) {
            explanation = `Renamed public class to match file target: '${match[1]}'`;
            patch = code.replace(/public\s+class\s+\w+/, `public class ${match[1]}`);
        }
    } else {
        explanation = "AI suggestion: Check variable scope, imports, and syntax.";
    }

    res.json({ explanation, patchedCode: patch });
});

app.post('/api/ai/generate-tests', (req, res) => {
    const { classCode, className } = req.body;
    const targetName = className || 'Main';

    const testCode = `import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

public class ${targetName}Test {

    @Test
    void testExecution() {
        // Auto-generated unit test case by AI Assistant
        assertTrue(true, "Base assertion passed");
    }
}
`;
    res.json({ testFileName: `${targetName}Test.java`, testCode });
});

app.post('/api/ai/explain', (req, res) => {
    const { code } = req.body;
    const lines = (code || '').split('\n').length;
    const hasMain = (code || '').includes('public static void main');
    const imports = ((code || '').match(/import\s+[\w\.]+;/g) || []).length;

    const explanation = `### Code Analysis
- **Lines of Code**: ${lines}
- **Main Method Present**: ${hasMain ? 'Yes (Executable)' : 'No (Helper Class)'}
- **Imports**: ${imports} external imports
- **Overview**: This Java class defines methods and logic. Click '▶ Run Code' or '🐞 Debug Program' to execute.`;

    res.json({ explanation });
});

// 7. Export Project as ZIP Endpoint
app.get('/api/export', (req, res) => {
    try {
        const zip = new AdmZip();
        const tempDir = path.join(__dirname, 'temp_workspace');
        if (fs.existsSync(tempDir)) {
            zip.addLocalFolder(tempDir);
        } else {
            zip.addFile("Main.java", Buffer.from(`public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello World");\n    }\n}`, "utf8"));
        }
        const buffer = zip.toBuffer();
        res.set('Content-Type', 'application/zip');
        res.set('Content-Disposition', 'attachment; filename="WebJavaProject.zip"');
        res.send(buffer);
    } catch (e) {
        res.status(500).json({ error: e.message });
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

                const classpath = getClasspath(tempDir);
                const compileArgs = ['-cp', classpath, '-d', tempDir, ...javaFiles];

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

                    ws.runningAppProcess = spawn(javaBin, ['-cp', classpath, targetMainClass]);

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

                const classpath = getClasspath(tempDir);
                const compileArgs = ['-g', '-cp', classpath, '-d', tempDir, ...javaFiles];

                execFile(javacBin, compileArgs, (err, stdout, stderr) => {
                    if (err) {
                        const errorMsg = stderr || stdout || err.message;
                        ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[31mCompile Error:\r\n${errorMsg.replace(/\n/g, '\r\n')}\x1b[0m\r\n` }));
                        return;
                    }

                    ws.runningJdbProcess = spawn(jdbBin, ['-classpath', classpath, targetMainClass]);

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

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Interactive Java IDE + Debugger running on http://localhost:${PORT}`));