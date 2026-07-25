const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parseStringPromise } = require('xml2js');

const app = express();
app.use(express.json());
app.use(express.static('public'));

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

/**
 * Helper to write a list of files into a workspace directory.
 * files format: [{ name: "Calculator.java", path: "com/example/Calculator.java", content: "..." }]
 */
function setupWorkspace(files, workspaceDir) {
    if (fs.existsSync(workspaceDir)) {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
    fs.mkdirSync(workspaceDir, { recursive: true });

    const writtenFiles = [];
    for (const file of files) {
        const fullPath = path.join(workspaceDir, file.path);
        const dirName = path.dirname(fullPath);
        if (!fs.existsSync(dirName)) {
            fs.mkdirSync(dirName, { recursive: true });
        }
        fs.writeFileSync(fullPath, file.content);
        if (file.name.endsWith('.java')) {
            writtenFiles.push(fullPath);
        }
    }
    return writtenFiles;
}

// --- RUN CORE JAVA PROGRAM ENDPOINT ---
app.post('/api/run', (req, res) => {
    let { jdkPath, files, mainClass } = req.body;

    if (!jdkPath || jdkPath.trim() === '') jdkPath = getSystemJdkPath();
    if (!jdkPath) return res.status(400).json({ error: "JDK path not found." });
    if (!files || files.length === 0) return res.status(400).json({ error: "No files provided." });

    const isWin = process.platform === 'win32';
    const javacBin = path.join(jdkPath, 'bin', isWin ? 'javac.exe' : 'javac');
    const javaBin = path.join(jdkPath, 'bin', isWin ? 'java.exe' : 'java');

    const tempDir = path.join(__dirname, 'temp_workspace');
    const javaFiles = setupWorkspace(files, tempDir);

    if (javaFiles.length === 0) {
        return res.status(400).json({ error: "No .java files found to compile." });
    }

    // Compile all Java files together
    const javaFilesArg = javaFiles.map(f => `"${f}"`).join(' ');
    const compileCmd = `"${javacBin}" -d "${tempDir}" ${javaFilesArg}`;

    exec(compileCmd, (compileErr, stdout, stderr) => {
        if (compileErr || stderr) {
            return res.json({ success: false, isCompileError: true, output: stderr || compileErr.message });
        }

        // Run the target main class
        const runCmd = `"${javaBin}" -cp "${tempDir}" ${mainClass}`;
        exec(runCmd, (runErr, runStdout, runStderr) => {
            if (runErr || runStderr) {
                return res.json({ success: false, output: runStderr || runErr.message });
            }
            res.json({ success: true, output: runStdout });
        });
    });
});

// --- RUN JUNIT 5 TESTS ENDPOINT ---
app.post('/api/test', async (req, res) => {
    let { jdkPath, files, testClass } = req.body;

    if (!jdkPath || jdkPath.trim() === '') jdkPath = getSystemJdkPath();
    if (!jdkPath) return res.status(400).json({ error: "JDK path not found." });
    if (!fs.existsSync(JUNIT_JAR)) {
        return res.status(500).json({ error: `JUnit Standalone JAR missing at ${JUNIT_JAR}` });
    }

    const isWin = process.platform === 'win32';
    const javacBin = path.join(jdkPath, 'bin', isWin ? 'javac.exe' : 'javac');
    const javaBin = path.join(jdkPath, 'bin', isWin ? 'java.exe' : 'java');

    const tempDir = path.join(__dirname, 'temp_workspace');
    const reportsDir = path.join(__dirname, 'temp_reports');

    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

    const javaFiles = setupWorkspace(files, tempDir);

    const cpDelimiter = isWin ? ';' : ':';
    const classpath = `"${tempDir}${cpDelimiter}${JUNIT_JAR}"`;
    const javaFilesArg = javaFiles.map(f => `"${f}"`).join(' ');

    // Compile all files with JUnit JAR on classpath
    const compileCmd = `"${javacBin}" -cp ${classpath} -d "${tempDir}" ${javaFilesArg}`;

    exec(compileCmd, async (compileErr, stdout, stderr) => {
        if (compileErr || stderr) {
            return res.json({ success: false, isCompileError: true, output: stderr || compileErr.message });
        }

        // Execute JUnit 5 Console Launcher
        const runTestCmd = `"${javaBin}" -jar "${JUNIT_JAR}" execute --class-path "${tempDir}" --select-class ${testClass} --reports-dir "${reportsDir}"`;

        exec(runTestCmd, async (runErr, runStdout, runStderr) => {
            try {
                const xmlFiles = fs.readdirSync(reportsDir).filter(f => f.endsWith('.xml'));
                if (xmlFiles.length === 0) {
                    return res.json({ success: false, output: runStderr || "No test reports generated." });
                }

                const xmlData = fs.readFileSync(path.join(reportsDir, xmlFiles[0]), 'utf-8');
                const parsedXml = await parseStringPromise(xmlData);
                const testsuite = parsedXml.testsuite.$;
                const testcases = parsedXml.testsuite.testcase || [];

                const results = {
                    total: parseInt(testsuite.tests || 0),
                    failures: parseInt(testsuite.failures || 0),
                    errors: parseInt(testsuite.errors || 0),
                    skipped: parseInt(testsuite.skipped || 0),
                    time: parseFloat(testsuite.time || 0).toFixed(3),
                    tests: testcases.map(tc => {
                        const hasFailure = tc.failure || tc.error;
                        return {
                            name: tc.$.name,
                            className: tc.$.classname,
                            time: tc.$.time,
                            passed: !hasFailure,
                            message: hasFailure ? (hasFailure[0].$.message || hasFailure[0]._) : null
                        };
                    })
                };

                fs.rmSync(reportsDir, { recursive: true, force: true });
                res.json({ success: true, results });
            } catch (err) {
                res.json({ success: false, output: "Failed to parse test results: " + err.message });
            }
        });
    });
});

app.listen(3000, () => console.log('Multi-file Java IDE running on http://localhost:3000'));