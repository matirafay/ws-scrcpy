const path = require('path');

function srcDir() {
    return path.join(__dirname, '..');
}

function appRoot() {
    return path.join(srcDir(), '..');
}

function scriptFile(name) {
    return path.join(appRoot(), 'scripts', name);
}

function vendorAdb(fileName) {
    return path.join(appRoot(), 'vendor', 'platform-tools', fileName);
}

function configExample() {
    return path.join(appRoot(), 'config.example.json');
}

module.exports = { srcDir, appRoot, scriptFile, vendorAdb, configExample };
