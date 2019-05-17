const debug = require('debug')('loki:chrome:docker');
const os = require('os');
const { execSync } = require('child_process');
const execa = require('execa');
const waitOn = require('wait-on');
const CDP = require('chrome-remote-interface');
const fs = require('fs-extra');
const getRandomPort = require('get-port');
const { ensureDependencyAvailable } = require('../../dependency-detection');
const createChromeTarget = require('./create-chrome-target');

const getLocalIPAddress = () => {
  const interfaces = os.networkInterfaces();
  const ips = Object.keys(interfaces)
    .map(key =>
      interfaces[key]
        .filter(({ family, internal }) => family === 'IPv4' && !internal)
        .map(({ address }) => address)
    )
    .reduce((acc, current) => acc.concat(current), []);
  return ips[0];
};

const waitOnCDPAvailable = (host, port) =>

  console.log({
    'waitOnCDPAvailable': `tcp:${host}:${port}`
  });
  

  new Promise((resolve, reject) => {
    waitOn(
      {
        resources: [`tcp:${host}:${port}`],
        delay: 50,
        interval: 100,
        timeout: 5000,
      },
      err => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });

const getNetworkHost = async dockerId => {
  let host = '127.0.0.1';

  // https://tuhrig.de/how-to-know-you-are-inside-a-docker-container/
  const runningInsideDocker =
    fs.existsSync('/proc/1/cgroup') &&
    /docker/.test(fs.readFileSync('/proc/1/cgroup', 'utf8'));

  // If we are running inside a docker container, our spawned docker chrome instance will be a sibling on the default
  // bridge, which means we can talk directly to it via its IP address.
  if (runningInsideDocker) {
    const { code, stdout } = await execa('docker', [
      'inspect',
      '-f',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      dockerId,
    ]);

    if (code !== 0) {
      throw new Error('Unable to determine IP of docker container');
    }

    host = stdout;
  }

  return host;
};

function createChromeDockerTarget({
  baseUrl = 'http://localhost:6006',
  chromeDockerImage = 'yukinying/chrome-headless',
  chromeFlags = ['--headless', '--disable-gpu', '--hide-scrollbars'],
}) {
  let port;
  let dockerId;
  let host;
  let dockerUrl = baseUrl;
  const dockerPath = 'docker';
  const runArgs = ['run', '--rm', '-d', '-P'];

  console.log({
    zed: 'DOcker target',   port, dockerId,host,dockerUrl, isCI: process.env.CI
  });
  

  if (!process.env.CI) {
    runArgs.push(`--security-opt=seccomp=${__dirname}/docker-seccomp.json`);
  }
console.log({
  test: baseUrl.indexOf('http://localhost') === 0,
  test2: (baseUrl.indexOf('file:') === 0)
})
  if (baseUrl.indexOf('http://localhost') === 0) {
    const ip = getLocalIPAddress();
    if (!ip) {
      throw new Error(
        'Unable to detect local IP address, try passing --host argument'
      );
    }
    dockerUrl = baseUrl.replace('localhost', ip);
  } else if (baseUrl.indexOf('file:') === 0) {
    const staticPath = baseUrl.substr('file:'.length);
    const staticMountPath = '/var/loki';
    runArgs.push('-v');
    runArgs.push(`${staticPath}:${staticMountPath}`);
    dockerUrl = `file://${staticMountPath}`;
  }

  console.log(9);
  

  async function getIsImageDownloaded(imageName) {
    const { code, stdout, stderr } = await execa(dockerPath, [
      'images',
      '-q',
      imageName,
    ]);
    if (code !== 0) {
      throw new Error(`Failed querying docker, ${stderr}`);
    }
    return stdout.trim().length !== 0;
  }
  console.log(8);
  async function ensureImageDownloaded() {
    ensureDependencyAvailable('docker');

    const isImageDownloaded = await getIsImageDownloaded(chromeDockerImage);
    if (!isImageDownloaded) {
      await execa(dockerPath, ['pull', chromeDockerImage]);
    }
  }
  console.log(7);
  async function start() {
    port = await getRandomPort();
    console.log(6);
    ensureDependencyAvailable('docker');
    const args = runArgs
      .concat([
        '--shm-size=1g',
        '-p',
        `${port}:${port}`,
        chromeDockerImage,
        '--disable-datasaver-prompt',
        '--no-first-run',
        '--disable-extensions',
        '--remote-debugging-address=0.0.0.0',
        `--remote-debugging-port=${port}`,
      ])
      .concat(chromeFlags);
      console.log({args});
      
    debug(
      `Launching chrome in docker with command "${dockerPath} ${args.join(
        ' '
      )}"`
    );
    console.log(5);
    const { code, stdout, stderr } = await execa(dockerPath, args);

    console.log({ TEST: 'EXECA',code, stdout, stderr });


    if (code === 0) {
      dockerId = stdout;
      host = await getNetworkHost(dockerId);
      await waitOnCDPAvailable(host, port);
      debug(`Docker started with id ${dockerId}`);
    } else {
      throw new Error(`Failed starting docker, ${stderr}`);
    }
  }
  console.log(4);
  async function stop() {
    if (dockerId) {
      debug(`Killing chrome docker instance with id ${dockerId}`);
      await execa(dockerPath, ['kill', dockerId]);
    } else {
      debug('No chrome docker instance to kill');
    }
  }
  console.log(3);
  async function createNewDebuggerInstance() {
    debug(`Launching new tab with debugger at port ${host}:${port}`);
    const target = await CDP.New({ host, port });
    debug(`Launched with target id ${target.id}`);
    const client = await CDP({ host, port, target });

    client.close = () => {
      debug('New closing tab');
      return CDP.Close({ host, port, id: target.id });
    };

    return client;
  }
  console.log(2);
  process.on('SIGINT', () => {
    if (dockerId) {
      execSync(`${dockerPath} kill ${dockerId}`);
    }
  });
  console.log(1);
  return createChromeTarget(
    start,
    stop,
    createNewDebuggerInstance,
    dockerUrl,
    ensureImageDownloaded
  );
}

module.exports = createChromeDockerTarget;
