const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public')); // Serves frontend assets

app.post('/api/run', (req, res) => {
    const { jdkPath, code, className } = req.body;

    if (!jdkPath || !code || !className) {
        return res.status(400).json({ error: "JDK path, class name, and code are required." });
    }

    // Resolve binaries inside the user's selected JDK folder
    const javacBin = path.join(jdkPath, 'bin', 'javac');
    const javaBin = path.join(jdkPath, 'bin', 'java');

    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

    const javaFilePath = path.join(tempDir, `${className}.java`);

    // Write source code to temp directory
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