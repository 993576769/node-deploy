/* eslint-disable no-console */
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
const { exec } = require('child-process-promise');
const { NodeSSH: OriginNodeSSH } = require('node-ssh');
const _ = require('lodash');
const { glob } = require('glob');
const tar = require('tar-stream');
const DeployToOss = require('./deploy-ali-oss');
const DeployToCos = require('./deploy-tencent-cos');

const defaultConfig = {
  username: 'deploy',
  port: '22',
  privateKeyPath: `${os.homedir()}/.ssh/id_rsa`,
};

class NodeSSH extends OriginNodeSSH {
  constructor(deployConfig = {}) {
    super();
    const {
      afterUpload,
      project_dir,
      namespace = 'current',
      release_name,
      local_target,
      tar = false,
      excludes = [],
      includes = [],
      versionsRetainedNumber = 1,
      globOptions = {},
      localOnly = false,
    } = this.deployConfig = deployConfig;

    this.afterUpload = afterUpload;
    this.localTarget = local_target;
    this.tar = tar;
    this.includes = includes;
    // 如果是本地模式，自动排除 build.tar.gz 避免循环打包
    this.excludes = localOnly ? [...excludes, 'build.tar.gz'] : excludes;
    this.versionsRetainedNumber = Math.max(versionsRetainedNumber, 1);
    this.globOptions = globOptions;
    this.projectDir = project_dir; // /var/www/xxx-frontend
    this.namespace = namespace; // app
    this.distTarget = path.posix.join(this.projectDir, this.namespace); // /var/www/xxx-frontend/app
    this.releasesDir = path.posix.join(this.projectDir, [this.namespace, 'releases'].join('-')); // /var/www/xxx-frontend/app-releases
    this.newReleaseDir = path.posix.join(this.releasesDir, release_name); // /var/www/xxx-frontend/app-releases/YYYY-MM-DD_HH_mm
  }

  forwardOut(...args) {
    return new Promise((resolve, reject) => {
      this.connection.forwardOut(...args, (err, stream) => {
        if (err) {
          reject(err);
          this.connection.end();
        } else {
          resolve(stream);
        }
      });
    });
  }

  async connect2(config, assignDefault = true) {
    if (assignDefault) { config = Object.assign({}, defaultConfig, config); }
    console.log('connect:', {
      host: config.host,
      post: config.port,
      forwardOut: config.forwardOut,
      isSock: Boolean(config.sock),
    });
    await this.connect(config);

    let { forwardOut } = config;
    if (forwardOut) {
      forwardOut = Object.assign({}, defaultConfig, forwardOut);
      console.log(`forwardOut('127.0.0.1', 22, ${forwardOut.host}, ${forwardOut.port})`);
      const stream = await this.forwardOut('127.0.0.1', 22, forwardOut.host, forwardOut.port);
      const ssh = new this.constructor(this.deployConfig);
      return ssh.connect2({
        sock: stream,
        ..._.omit(forwardOut, 'host', 'port'),
      }, false);
    } else {
      return this;
    }
  }

  // 使用 glob 和 tar-stream 打包
  // glob 语法示例：
  //   - excludes: ['node_modules/**'] -> 排除根目录的 node_modules
  //   - excludes: ['**/node_modules/**'] -> 排除所有层级的 node_modules
  //   - excludes: ['.git/**'] -> 排除根目录的 .git
  //   - excludes: ['**/.DS_Store'] -> 排除所有 .DS_Store 文件
  //   - includes: ['dist/**', 'public/**'] -> 只打包这些目录
  //   - globOptions: { maxDepth: 3 } -> 自定义 glob 选项（如限制目录遍历深度）
  //   - localOnly: true -> 本地打包模式，自动排除 build.tar.gz 避免循环打包
  async createTar(localTarPath) {
    const pack = tar.pack();
    const gzip = zlib.createGzip();
    const output = fs.createWriteStream(localTarPath);

    // 管道：pack -> gzip -> output
    pack.pipe(gzip).pipe(output);

    // 构建包含模式
    const patterns = this.includes.length > 0 ? this.includes : ['**/*'];

    // 使用 glob 获取所有匹配的文件
    const allFileLists = await Promise.all(
      patterns.map(pattern =>
        glob(pattern, {
          cwd: this.localTarget,
          dot: true,
          nodir: false,
          ignore: this.excludes,
          ...this.globOptions,
        }),
      ),
    );

    // 合并并去重
    const allFiles = [...new Set(allFileLists.flat())].sort();

    console.log(`找到 ${allFiles.length} 个文件/目录需要打包`);
    console.log(`包含模式: ${JSON.stringify(patterns)}`);
    console.log(`排除模式: ${JSON.stringify(this.excludes)}`);

    // 逐个添加文件到 tar
    let processed = 0;
    for (const file of allFiles) {
      const fullPath = path.join(this.localTarget, file);
      const stats = fs.statSync(fullPath);

      if (stats.isDirectory()) {
        pack.entry({ name: file, type: 'directory' });
      } else {
        const content = fs.readFileSync(fullPath);
        pack.entry({ name: file, size: content.length }, content);
      }

      processed++;
      if (processed % 100 === 0) {
        console.log(`已处理 ${processed}/${allFiles.length} 个文件...`);
      }
    }

    return new Promise((resolve, reject) => {
      output.on('finish', () => {
        console.log(`✅ Tar 打包完成: ${localTarPath}`);
        resolve();
      });
      output.on('error', reject);
      pack.finalize();
    });
  }

  async upload() {
    if (this.tar) {
      // 如果是本地模式或没有 SSH 配置，直接生成到项目目录
      const noSSH = !this.deployConfig.ssh_configs || this.deployConfig.ssh_configs.length === 0;
      const localTarPath = (this.deployConfig.localOnly || noSSH)
        ? path.resolve('./build.tar.gz')
        : path.posix.join('/tmp', `build-${crypto.randomBytes(4).toString('hex')}.tar.gz`);

      // 使用 glob + tar-stream 打包
      console.log('使用 tar-stream 打包（支持 glob 语法）...');
      await this.createTar(localTarPath);

      // 如果是本地模式，直接返回
      if (this.deployConfig.localOnly) {
        console.log(`✅ 本地打包完成: ${localTarPath}`);

        // 列出打包内容供用户检查
        console.log('\n📦 打包内容预览:');
        const { stdout } = await exec(`tar -tzf ${localTarPath} | head -50`);
        console.log(stdout);
        const { stdout: total } = await exec(`tar -tzf ${localTarPath} | wc -l`);
        console.log(`... 共 ${total.trim()} 个文件\n`);
        return;
      }

      const remoteTarPath = path.posix.join(this.newReleaseDir, 'build.tar.gz');
      console.log(`putFile(${localTarPath}, ${remoteTarPath})`);
      await this.putFile(localTarPath, remoteTarPath);
      await exec(`rm ${localTarPath}`);
      console.log('putFile completed');

      console.log(`execCommand(tar xzvf ${remoteTarPath} -C ${this.newReleaseDir})`);
      await this.execCommand(`tar xzvf ${remoteTarPath} -C ${this.newReleaseDir}`);
      console.log(`execCommand(rm -rf ${remoteTarPath})`);
      await this.execCommand(`rm -rf ${remoteTarPath}`);
    } else {
      await this.uploadDirectory(this.localTarget, this.newReleaseDir, {
        recursive: true,
        concurrency: 1,
      });
      console.log('putDirectory completed');
    }

    await this.execCommand(`ln -sfn ${this.newReleaseDir} ${this.distTarget}`);
    console.log(`${this.distTarget} -> ${this.newReleaseDir} completed`);

    const { stdout } = await this.execCommand(`ls ${this.releasesDir}`);
    const arr = _.sortBy(_.split(stdout, '\n'));
    await this.execCommand(`rm -rf ${_.dropRight(arr, this.versionsRetainedNumber).map(name => path.posix.join(this.releasesDir, name)).join(' ')}`);
    this.afterUpload && (await this.afterUpload(this));
  }

  uploadDirectory(...args) {
    return this.putDirectory(...args);
  }

  static async deploy({ ssh_configs, ...deployConfig }) {
    // 本地模式：如果没有 SSH 配置或使用 localOnly，直接打包
    const isLocalMode = !ssh_configs || ssh_configs.length === 0 || deployConfig.localOnly;

    if (isLocalMode) {
      const ssh = new this(deployConfig);
      try {
        await ssh.upload();
      } catch (err) {
        console.error(err);
        process.exit(1);
      }
      return;
    }

    // SSH 部署模式
    for (const sshConfig of ssh_configs) {
      const ssh = new this(deployConfig);
      let lastSSH;
      try {
        lastSSH = await ssh.connect2(sshConfig);
        console.log('ssh connected');

        await lastSSH.upload();
      } catch (err) {
        console.error(err);
        process.exit(1);
      } finally {
        // 静默处理连接关闭时可能触发的 ECONNRESET 错误（远端主动断开属正常行为）
        if (ssh.connection) {
          ssh.connection.on('error', () => {});
        }
        if (lastSSH && lastSSH !== ssh && lastSSH.connection) {
          lastSSH.connection.on('error', () => {});
        }
        ssh.dispose();
      }
    }
  }
}

function deploy(config) {
  if (
    config.cosSecretId
    && config.cosSecretKey
    && config.cosBucket
    && config.cosRegion
  ) {
    console.log('使用腾讯云COS');
    return DeployToCos.deploy(config).then(() => NodeSSH.deploy(config));
  } else if (
    config.ossAccessKeyId
    && config.ossAccessKeySecret
    && config.ossBucket
    && config.ossEndpoint
  ) {
    console.log('使用阿里云OSS');
    return DeployToOss.deploy(config).then(() => NodeSSH.deploy(config));
  } else {
    return NodeSSH.deploy(config);
  }
}

if (require.main === module) {
  const deployConfig = require(path.posix.resolve('deploy.config.js'));
  return deploy(deployConfig);
} else {
  module.exports = { NodeSSH, DeployToOss, DeployToCos, deploy };
}
