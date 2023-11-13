const { Client } = require('ssh2');
const scpClient = require('scp2');

const ssh = new Client();

const fs = require('fs');
const child_process = require('child_process');

const privateKey = 'path/to/your/key.rsa';

const sshConfigIntermediate = {
    // name: 'prod.brainlife.io',
    host: '149.165.152.60',
    username: 'ubuntu',
    privateKey: require('fs').readFileSync(privateKey),
    // passphrase: 'your key passphrase',
}

const destinationServerDetails = {
    remoteHost: '10.0.18.41',//'prod-api-1',
    remotePort: 22,
    remoteUsername: 'ubuntu',
    remotePath: '/tmp/test/'
};

const sourceServerDetails = {
    localPath: '/tmp/test/',
    localPort: 50000 // This is the port that you are forwarding to the destination server
}

console.log(`Looking for key in: ${privateKey}`, fs.existsSync(privateKey));
console.log(`Current working directory: ${process.cwd()}`);

// ssh -L 50000:prod-api-1:22 ubuntu@prod.brainlife.io -fN
// rsync -azv -e 'ssh -p 50000' /tmp/test/file.txt ubuntu@localhost:/tmp/test/file.txt


if (!fs.existsSync(privateKey)) {
    console.error('Private key file not found');
} else {
    ssh.on('ready', () => {
        console.log('SSH Client Ready');

        ssh.forwardOut('127.0.0.1', sourceServerDetails.localPort, destinationServerDetails.remoteHost,
            destinationServerDetails.remotePort, (err, stream) => {
                if (err) {
                    console.error('Error: ', err);
                }

                console.log('Forwarding connection established');
                const rsyncCommand = `rsync -azv -e 'ssh -p ${sourceServerDetails.localPort}' ${sourceServerDetails.localPath} ubuntu@127.0.0.1:${destinationServerDetails.remotePath}`;

                child_process.exec(rsyncCommand, (err, stdout, stderr) => {
                    if (err) {
                        console.error('Error: ', err);
                    }

                    console.log('stdout: ', stdout);
                    console.log('stderr: ', stderr);

                    ssh.end();
                });
            });
    }).connect(sshConfigIntermediate);
}
