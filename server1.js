const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

/**
 * Resolves the JDK home directory from system environment variables.
 * Checks standard process.env.JAVA_HOME first, then inspects PATH.
 */
function getSystemJdkPath() {
    // 1. Check direct JAVA_HOME environment variable
    if (process.env.JAVA_HOME && fs.existsSync(process.env.JAVA_HOME)) {
        return process.env.JAVA_HOME;
    }

    // 2. Fallback: If JAVA_HOME is not set, attempt to locate via PATH binaries
    const pathDirs = (process.env.PATH || '').split(path.delimiter);
    for (const dir of pathDirs) {
        const javacExecutable = path.join(dir, process.platform === 'win32' ? 'javac.exe' : 'javac');
        if (fs.existsSync(javacExecutable)) {
            // Move up one level from 'bin' to get the root JDK path
            return path.dirname(dir);
        }
    }

    return null;
}

// Endpoint to let frontend fetch detected system JDK on load
app.get('/api/jdk-path', (req, res) => {
    const systemJdk = getSystemJdkPath();
    res.json({ jdkPath: systemJdk || '' });
});

app.post('/api/run', (req, res) => {
    let { jdkPath, code, className } = req.body;

    // Use user-provided path if available, otherwise fallback to system JDK
    if (!jdkPath || jdkPath.trim() === '') {
        jdkPath = getSystemJdkPath();
    }

    if (!jdkPath) {
        return res.status(400).json({ 
            error: "JDK path not found. Please set JAVA_HOME in system environment variables or provide a path manually." 
        });
    }

    if (!code || !className) {
        return res.status(400).json({ error: "Class name and code are required." });
    }

    // Determine binary paths (handling Windows .exe extensions)
    const isWin = process.platform === 'win32';
    const javacBin = path.join(jdkPath, 'bin', isWin ? 'javac.exe' : 'javac');
    const javaBin = path.join(jdkPath, 'bin', isWin ? 'java.exe' : 'java');

    // Verify JDK executables actually exist
    if (!fs.existsSync(javacBin) || !fs.existsSync(javaBin)) {
        return res.json({ 
            success: false, 
            output: `Invalid JDK path: Executables not found at ${javacBin}` 
        });
    }

    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

    const javaFilePath = path.join(tempDir, `${className}.java`);
    fs.writeFileSync(javaFilePath, code);

    // Step 1: Compile
    const compileCmd = `"${javacBin}" "${javaFilePath}"`;
    exec(compileCmd, (compileErr, stdout, stderr) => {
        if (compileErr || stderr) {
            return res.json({ success: false, output: stderr || compileErr.message });
        }

        // Step 2: Run
        const runCmd = `"${javaBin}" -cp "${tempDir}" ${className}`;
        exec(runCmd, (runErr, runStdout, runStderr) => {
            if (runErr || runStderr) {
                return res.json({ success: false, output: runStderr || runErr.message });
            }
            res.json({ success: true, output: runStdout });
        });
    });
});

app.listen(3000, () => console.log('Local Java IDE running on http://localhost:3000'));