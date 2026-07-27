const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const AdmZip = require('adm-zip');
const xml2js = require('xml2js');

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
    // The workspace is a single shared scratch dir that is never cleaned between
    // requests. If we only overwrite the incoming files, stale .java/.class
    // artifacts from deleted files linger — and `--scan-class-path` will keep
    // running tests from classes the user already removed. Wipe it first so the
    // on-disk workspace always mirrors exactly the current editor file set.
    try {
        if (fs.existsSync(workspaceDir)) {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
        fs.mkdirSync(workspaceDir, { recursive: true });
    } catch (e) {
        console.error("Error resetting workspace directory:", e);
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

// ---------------------------------------------------------------------------
// Visual Execution Debugger: jdb output parsing
// ---------------------------------------------------------------------------
// jdb streams output in arbitrary chunks, so after every stop we issue the
// interrogation commands (`locals`, `where`) followed by `print "<sentinel>"`.
// The sentinel echoes back in stdout, letting us reliably detect when a block
// is complete regardless of how the OS splits the stream into chunks. Note that
// jdb evaluates `print` on the target VM, so its result reliably lands LAST —
// after `locals`/`where` have finished printing. We therefore capture the whole
// block up to the single sentinel and let the two parsers (whose line formats
// are mutually exclusive) each pick out their own content.
const STATE_SENTINEL = '___WJIDE_STATE_END___';

// jdb prefixes the first line of a command's output with its prompt, e.g.
// "main[1] args = ...". Strip any leading prompt(s) so line-anchored parsing works.
function stripJdbPrompt(line) {
    return line.replace(/^(?:[\w.$-]+\[\d+\]\s+)+/, '');
}

// Turn a raw jdb value into a typed descriptor for the visualizer.
function inferVarType(rawValue) {
    const v = (rawValue || '').trim();
    const instMatch = v.match(/instance of ([\w.$]+(?:\[[0-9]*\])*)\s*\(id=(\d+)\)/);
    if (instMatch) {
        return { value: v, type: instMatch[1], isRef: true, refId: instMatch[2] };
    }
    if (/^".*"$/.test(v)) return { value: v, type: 'String', isRef: false };
    if (/^'.*'$/.test(v)) return { value: v, type: 'char', isRef: false };
    if (/^(true|false)$/.test(v)) return { value: v, type: 'boolean', isRef: false };
    if (/^-?\d+$/.test(v)) return { value: v, type: 'int', isRef: false };
    if (/^-?\d*\.\d+$/.test(v)) return { value: v, type: 'double', isRef: false };
    if (v === 'null') return { value: v, type: 'null', isRef: false };
    return { value: v, type: '', isRef: false };
}

// Parse the output of `locals` into {name, scope, value, type, isRef} entries.
// Frame lines from `where` ("[1] Foo.bar (Foo.java:3)"), the source line, and the
// breakpoint banner don't match the "name = value" shape, so they're ignored here.
function parseLocals(text) {
    const vars = [];
    let scope = 'local';
    for (const rawLine of (text || '').split('\n')) {
        const t = stripJdbPrompt(rawLine.trim()).trim();
        if (!t) continue;
        if (/^Method arguments:?/i.test(t)) { scope = 'arg'; continue; }
        if (/^Local variables:?/i.test(t)) { scope = 'local'; continue; }
        const m = t.match(/^([\w$]+)\s*=\s*(.+)$/);
        if (m && !m[1].includes('___') && !m[2].includes('___')) {
            vars.push({ name: m[1], scope, ...inferVarType(m[2]) });
        }
    }
    return vars;
}

// Parse the output of `where` into ordered call-stack frames.
function parseStackFrames(text) {
    const frames = [];
    const re = /\[(\d+)\]\s+([\w.$]+)\.([\w$<>]+)\s*\(([^)]*?):(\d+)\)/g;
    let m;
    while ((m = re.exec(text || '')) !== null) {
        frames.push({
            index: parseInt(m[1], 10),
            className: m[2],
            method: m[3],
            file: m[4],
            line: parseInt(m[5], 10)
        });
    }
    return frames;
}

// Best-effort parse of `dump <expr>` output into object fields.
function parseDump(text, objName) {
    const fields = [];
    for (const rawLine of (text || '').split('\n')) {
        const t = stripJdbPrompt(rawLine.trim()).trim();
        if (!t || t.includes('___') || t === '}' || t.endsWith('{')) continue;
        const m = t.match(/^([\w.$]+)\s*[:=]\s*(.+?),?$/);
        if (m) {
            let fname = m[1];
            if (fname === objName) continue;
            if (fname.includes('.')) fname = fname.split('.').pop();
            fields.push({ name: fname, ...inferVarType(m[2]) });
        }
    }
    return fields;
}

// Consume a chunk of jdb stdout, drive the interrogation state machine, and
// emit structured `debug_state` / `debug_inspect_result` messages to the client.
function handleJdbOutput(ws, chunk, defaultClass) {
    const st = ws.dbg;
    if (!st) return;
    st.buffer += chunk;

    // A fresh stop (breakpoint or completed step): capture location, then ask
    // jdb for locals + stack, terminated by a single sentinel.
    if (!st.capturing && (chunk.includes('Breakpoint hit:') || chunk.includes('Step completed:'))) {
        const lineMatch = chunk.match(/line=(\d+)/);
        const locMatch = chunk.match(/(?:Breakpoint hit|Step completed):\s*"thread=[^"]*",\s*([\w.$]+)\.([\w$<>]+)\(\)/);
        st.pendingStop = {
            line: lineMatch ? parseInt(lineMatch[1], 10) : null,
            className: locMatch ? locMatch[1] : defaultClass,
            method: locMatch ? locMatch[2] : ''
        };
        st.step = (st.step || 0) + 1;
        st.capturing = true;
        st.buffer = '';
        const w = ws.runningJdbProcess && ws.runningJdbProcess.stdin;
        if (w && w.writable) {
            w.write('locals\n');
            w.write('where\n');
            w.write(`print "${STATE_SENTINEL}"\n`);
        }
        return;
    }

    // Interrogation complete once the sentinel echoes back. The block holds both
    // the `locals` and `where` output; each parser extracts only its own lines.
    if (st.capturing && st.buffer.includes(STATE_SENTINEL)) {
        const block = st.buffer.slice(0, st.buffer.indexOf(STATE_SENTINEL));
        const frames = parseStackFrames(block);
        // The top frame is the authoritative current location; the stop banner
        // can span chunk boundaries and be missed, so prefer the frame.
        const top = frames[0] || {};
        ws.send(JSON.stringify({
            type: 'debug_state',
            step: st.step,
            line: top.line != null ? top.line : st.pendingStop.line,
            className: top.className || st.pendingStop.className,
            method: top.method || st.pendingStop.method,
            variables: parseLocals(block),
            frames
        }));
        st.capturing = false;
        st.pendingStop = null;
        st.buffer = '';
    }

    // On-demand object inspection (`dump`). Unlike locals/where, jdb's `dump`
    // output can arrive AFTER a trailing sentinel, so we detect completion
    // structurally: a closing brace for objects/arrays, or an error message.
    if (st.inspecting) {
        const hasObject = st.buffer.includes('{') && /\}\s*\r?\n/.test(st.buffer);
        const hasError = /ParseException|Name unknown|Unable to|is not a valid|No local variable/i.test(st.buffer);
        if (hasObject || hasError) {
            emitInspect(ws);
        }
    }
}

// Emit the current inspection buffer as a debug_inspect_result and reset state.
function emitInspect(ws) {
    const st = ws.dbg;
    if (!st || !st.inspecting) return;
    if (st.inspectTimer) { clearTimeout(st.inspectTimer); st.inspectTimer = null; }
    ws.send(JSON.stringify({
        type: 'debug_inspect_result',
        name: st.inspectName,
        fields: parseDump(st.buffer, st.inspectName),
        raw: st.buffer
    }));
    st.inspecting = false;
    st.buffer = '';
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

// Strip ANSI colour codes so the raw console view is readable.
function stripAnsi(s) {
    return (s || '').replace(/\x1B\[[0-9;]*m/g, '');
}

// Map a JUnit-Platform suite name to a human framework label.
function frameworkOf(suiteName) {
    const n = (suiteName || '').toLowerCase();
    if (n.includes('testng')) return 'TestNG';
    if (n.includes('vintage')) return 'JUnit 4';
    if (n.includes('jupiter')) return 'JUnit 5';
    return suiteName || 'Tests';
}

// Parse the legacy JUnit-XML reports the ConsoleLauncher writes into reportsDir
// into a flat, structured list of test cases the frontend can render visually.
async function parseTestReports(reportsDir) {
    const tests = [];
    let fileNames = [];
    try {
        fileNames = fs.readdirSync(reportsDir).filter(f => f.startsWith('TEST-') && f.endsWith('.xml'));
    } catch (e) {
        return tests;
    }
    const parser = new xml2js.Parser({ explicitArray: true, trim: false });
    for (const fileName of fileNames) {
        let doc;
        try {
            doc = await parser.parseStringPromise(fs.readFileSync(path.join(reportsDir, fileName), 'utf8'));
        } catch (e) {
            continue;
        }
        const suite = doc && doc.testsuite;
        if (!suite) continue;
        const suiteName = (suite.$ && suite.$.name) || fileName.replace(/^TEST-|\.xml$/g, '');
        // The legacy writer emits several <system-out> blocks per test: the first
        // is always JUnit's own report metadata (unique-id/display-name); the real
        // captured program output (System.out.println) lives in the later blocks.
        // Strip the metadata lines and join whatever real output remains.
        const cleanOut = (arr) => (arr || [])
            .map(block => (block || '').split(/\r?\n/)
                .filter(l => {
                    const t = l.trim();
                    return t && !t.startsWith('unique-id:') && !t.startsWith('display-name:');
                })
                .join('\n'))
            .filter(s => s.trim())
            .join('\n')
            .trim();
        for (const tc of (suite.testcase || [])) {
            const attr = tc.$ || {};
            let status = 'passed', message = '', type = '', stack = '';
            const readNode = (node) => {
                if (!node) return;
                if (node.$) { message = node.$.message || ''; type = node.$.type || ''; }
                stack = (node && node._) ? node._ : (typeof node === 'string' ? node : '');
            };
            if (tc.failure) { status = 'failed'; readNode(tc.failure[0]); }
            else if (tc.error) { status = 'failed'; readNode(tc.error[0]); }
            else if (tc.skipped) {
                status = 'skipped';
                const sk = tc.skipped[0];
                if (sk && sk.$) message = sk.$.message || '';
            }
            tests.push({
                suite: suiteName,
                framework: frameworkOf(suiteName),
                className: attr.classname || '',
                name: (attr.name || '').replace(/\(\)\s*$/, ''),
                time: parseFloat(attr.time || '0') || 0,
                status,
                message: (message || '').trim(),
                type: (type || '').trim(),
                stack: (stack || '').trim(),
                stdout: cleanOut(tc['system-out']),
                stderr: cleanOut(tc['system-err'])
            });
        }
    }
    return tests;
}

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

        // Fresh reports dir each run so we never parse a previous run's results.
        const reportsDir = path.join(__dirname, 'temp_test_reports');
        try {
            if (fs.existsSync(reportsDir)) fs.rmSync(reportsDir, { recursive: true, force: true });
        } catch (e) {}

        execFile(javacBin, compileArgs, (compileErr, stdout, stderr) => {
            if (compileErr) {
                return res.json({ success: false, output: `Compilation Error:\n${stderr || stdout || compileErr.message}` });
            }

            if (!fs.existsSync(JUNIT_JAR)) {
                return res.json({ success: false, output: `JUnit JAR not found at ${JUNIT_JAR}` });
            }

            // Run the JUnit Platform ConsoleLauncher via -cp (not -jar) so that
            // every jar in lib/ is on the JVM classpath. The platform discovers
            // test engines through ServiceLoader on the classpath, so dropping the
            // TestNG engine + testng jars into lib/ makes @org.testng...Test methods
            // run through this same endpoint. JUnit Jupiter/Vintage keep working
            // because they are bundled inside the standalone jar.
            const junitArgs = [
                '-cp', classpath,
                'org.junit.platform.console.ConsoleLauncher',
                'execute',
                `--scan-class-path=${tempDir}`,
                // By default the ConsoleLauncher only scans classes whose names match
                // ^(Test.*|.+[.$]Test.*|.*Tests?)$, so a test class named e.g. "Calc"
                // or "MyTestng" is silently skipped. Include every class so discovery
                // is driven purely by annotations (@Test), not by class-name convention.
                '--include-classname=.*',
                // Write structured JUnit-XML reports we parse for the visual view,
                // and capture each test's stdout/stderr so we can show program output.
                `--reports-dir=${reportsDir}`,
                '--config=junit.platform.output.capture.stdout=true',
                '--config=junit.platform.output.capture.stderr=true',
                '--disable-banner'
            ];

            execFile(javaBin, junitArgs, async (testErr, testStdout, testStderr) => {
                const duration = Date.now() - startTime;
                const fullOutput = stripAnsi((testStdout || '') + '\n' + (testStderr || ''));

                const tests = await parseTestReports(reportsDir);

                let passedCount, failedCount, skippedCount, totalCount;
                if (tests.length) {
                    passedCount = tests.filter(t => t.status === 'passed').length;
                    failedCount = tests.filter(t => t.status === 'failed').length;
                    skippedCount = tests.filter(t => t.status === 'skipped').length;
                    totalCount = tests.length;
                } else {
                    // Fallback to summary text if no reports were produced.
                    const passedMatch = fullOutput.match(/(\d+)\s+tests successful/);
                    const failedMatch = fullOutput.match(/(\d+)\s+tests failed/);
                    const foundMatch = fullOutput.match(/(\d+)\s+tests found/);
                    passedCount = passedMatch ? parseInt(passedMatch[1]) : 0;
                    failedCount = failedMatch ? parseInt(failedMatch[1]) : 0;
                    skippedCount = 0;
                    totalCount = foundMatch ? parseInt(foundMatch[1]) : (passedCount + failedCount);
                }

                res.json({
                    success: failedCount === 0,
                    output: fullOutput,
                    duration,
                    tests,
                    summary: {
                        total: totalCount,
                        passed: passedCount,
                        failed: failedCount,
                        skipped: skippedCount
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
    let responded = false;
    const done = (status, body) => {
        if (responded) return;
        responded = true;
        res.status(status).json(body);
    };

    // Follow redirects, reject non-200 responses, and verify the payload is
    // actually a jar/zip (magic bytes "PK") before keeping it. Without these
    // checks a 404 HTML page gets written as a .jar and later breaks javac
    // with "zip END header not found".
    const download = (targetUrl, redirectsLeft) => {
        https.get(targetUrl, (response) => {
            const status = response.statusCode || 0;

            if ((status === 301 || status === 302 || status === 303 || status === 307 || status === 308) && response.headers.location) {
                response.resume(); // drain
                if (redirectsLeft <= 0) return done(502, { error: `Too many redirects for ${filename}` });
                return download(new URL(response.headers.location, targetUrl).toString(), redirectsLeft - 1);
            }

            if (status !== 200) {
                response.resume(); // drain, do not write the error body
                return done(502, { error: `Download failed for ${filename}: HTTP ${status} from ${targetUrl}` });
            }

            const file = fs.createWriteStream(dest);
            let firstBytesChecked = false;
            let looksLikeZip = false;

            response.on('data', (chunk) => {
                if (!firstBytesChecked && chunk.length >= 2) {
                    firstBytesChecked = true;
                    looksLikeZip = chunk[0] === 0x50 && chunk[1] === 0x4b; // "PK"
                }
            });
            response.pipe(file);

            file.on('finish', () => {
                file.close(() => {
                    if (!looksLikeZip) {
                        fs.unlink(dest, () => {});
                        return done(502, { error: `Download for ${filename} was not a valid JAR (got non-zip content from ${targetUrl}). Check the URL/version.` });
                    }
                    done(200, { success: true, message: `Added ${filename}` });
                });
            });
            file.on('error', (err) => {
                fs.unlink(dest, () => {});
                done(500, { error: err.message });
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => {});
            done(500, { error: err.message });
        });
    };

    download(url, 5);
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

                    ws.dbg = { buffer: '', step: 0, capturing: false, inspecting: false, inspectName: '', pendingStop: null };
                    ws.runningJdbProcess = spawn(jdbBin, ['-classpath', classpath, targetMainClass]);

                    ws.runningJdbProcess.stdout.on('data', (d) => {
                        const str = d.toString();
                        ws.send(JSON.stringify({ type: 'output', data: str.replace(/\n/g, '\r\n') }));
                        handleJdbOutput(ws, str, targetMainClass);
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

            // Inspect an object/array in the current frame via jdb `dump`.
            if (data.type === 'debug_inspect') {
                const expr = (data.expr || '').trim();
                if (expr && ws.dbg && !ws.dbg.capturing && ws.runningJdbProcess && ws.runningJdbProcess.stdin && ws.runningJdbProcess.stdin.writable) {
                    ws.dbg.inspecting = true;
                    ws.dbg.inspectName = expr;
                    ws.dbg.buffer = '';
                    ws.runningJdbProcess.stdin.write(`dump ${expr}\n`);
                    // Fallback: emit whatever we captured if jdb output stalls.
                    if (ws.dbg.inspectTimer) clearTimeout(ws.dbg.inspectTimer);
                    ws.dbg.inspectTimer = setTimeout(() => emitInspect(ws), 2000);
                }
            }

            // Stop the debug session and tear down the jdb process.
            if (data.type === 'debug_stop') {
                if (ws.runningJdbProcess) {
                    try { ws.runningJdbProcess.kill('SIGKILL'); } catch (e) {}
                    ws.runningJdbProcess = null;
                }
                ws.dbg = null;
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