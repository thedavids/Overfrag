const dotenv = require('dotenv');
const FTPDeploy = require('ftp-deploy');
const path = require('path');
const fs = require('fs');

dotenv.config({ path: '.env.deploy' });

const ftpDeploy = new FTPDeploy();

const ftpConfig = {
  user: process.env.FTP_USER,
  password: process.env.FTP_PASS,
  host: process.env.FTP_HOST,
  port: 21,
  localRoot: './dist',
  remoteRoot: process.env.FTP_REMOTE_DIR,
  include: ['*', '**/*'],
  deleteRemote: false
};

console.log('📁 Files in ./dist:', fs.readdirSync('./dist'));

ftpDeploy
  .deploy(ftpConfig)
  .then(() => console.log('✅ Deployed to HostGator!'))
  .catch(err => console.error('❌ FTP Deploy Error:', err));