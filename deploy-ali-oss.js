/* eslint-disable no-console */
const path = require('path');
const crypto = require('crypto');
const OSS = require('ali-oss');
const fs = require('fs-extra');
const { glob } = require('glob'); // glob v10+ 使用命名导出
const async = require('async');
const _ = require('lodash');
const dayjs = require('dayjs');

const DEPLOY_MANIFEST_DIR = '.node-deploy/releases';
const DELETE_BATCH_SIZE = 1000;

class DeployAliOss {
  constructor(config = {}) {
    const {
      ossAccessKeyId,
      ossAccessKeySecret,
      ossBucket,
      ossEndpoint,
      ossTimeout,
      ossNamespace,
      ossPattern,
      ossIgnore, // 支持排除特定文件或目录（字符串或数组）
      ossClearLocalFile,
      versionsRetainedNumber, // 保留的版本数量
      releaseName,
      release_name,
      local_target = path.resolve('dist'),
    } = config;

    this.config.ossClearLocalFile = typeof ossClearLocalFile === 'boolean' ? ossClearLocalFile : true;
    this.config.ossNamespace = String(ossNamespace || 'frontend').replace(/^\/+|\/+$/g, '');
    if (!this.config.ossNamespace || this.config.ossNamespace.split('/').some(part => part === '.' || part === '..' || !part)) {
      throw new Error(`Invalid OSS namespace: ${this.config.ossNamespace}`);
    }
    this.config.ossPattern = ossPattern || `${local_target}/**/*.!(html)`;
    this.config.ossIgnore = ossIgnore; // 支持 glob 的 ignore 选项
    this.config.versionsRetainedNumber = Number.isInteger(versionsRetainedNumber)
      ? Math.max(versionsRetainedNumber, 1)
      : 1;
    this.config.releaseName = String(releaseName || release_name || `${dayjs().format('YYYYMMDDHHmmssSSS')}-${crypto.randomBytes(4).toString('hex')}`);
    if (!/^[A-Za-z0-9._-]+$/.test(this.config.releaseName)) {
      throw new Error(`Invalid OSS release name: ${this.config.releaseName}`);
    }
    this.localTarget = local_target;

    this.client = new OSS({
      accessKeyId: ossAccessKeyId,
      accessKeySecret: ossAccessKeySecret,
      bucket: ossBucket,
      endpoint: ossEndpoint,
      timeout: ossTimeout || '600s',
    });
  }

  config = {};

  getFiles = async (pattern = this.config.ossPattern) => {
    // glob 10+ 支持 Promise API 和数组模式
    return await glob(pattern, { ignore: this.config.ossIgnore || [] });
  };

  getManifestPrefix = () => path.posix.join(this.config.ossNamespace, DEPLOY_MANIFEST_DIR);

  getManifestName = () => `${this.getManifestPrefix()}/${this.config.releaseName}.json`;

  getObjectName = (filePath) => {
    const relativePath = path.relative(this.localTarget, filePath);
    if (
      !relativePath
      || relativePath === '..'
      || relativePath.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativePath)
    ) {
      throw new Error(`Refusing to upload file outside local target: ${filePath}`);
    }

    const objectName = path.posix.join(
      this.config.ossNamespace,
      relativePath.split(path.sep).join(path.posix.sep),
    );
    if (objectName.startsWith(`${this.getManifestPrefix()}/`)) {
      throw new Error(`Refusing to upload into reserved OSS manifest directory: ${filePath}`);
    }

    return objectName;
  };

  listAllObjects = async (prefix) => {
    const objects = [];
    let marker;

    do {
      const result = await this.client.list({
        'prefix': prefix,
        'max-keys': 1000,
        ...(marker ? { marker } : {}),
      });
      objects.push(...(result.objects || []));

      if (result.isTruncated && !result.nextMarker) {
        throw new Error(`OSS list response is truncated without a next marker: ${prefix}`);
      }
      marker = result.isTruncated ? result.nextMarker : undefined;
    } while (marker);

    return objects;
  };

  uploadVersionManifest = async (files) => {
    const manifestPrefix = `${this.getManifestPrefix()}/`;
    const existingManifests = await this.listAllObjects(manifestPrefix);
    let manifestFiles = files;

    // Import pre-manifest objects into the first release so migrations retain
    // them for a full version window instead of deleting or leaking them.
    if (existingManifests.length === 0) {
      const existingObjects = await this.listAllObjects(`${this.config.ossNamespace}/`);
      manifestFiles = [...new Set([
        ...existingObjects
          .map(object => object.name)
          .filter(name => !name.startsWith(manifestPrefix)),
        ...files,
      ])];
      console.log(`已将 ${manifestFiles.length} 个现有OSS文件纳入首个发布清单`);
    }

    const manifest = {
      version: 1,
      releaseName: this.config.releaseName,
      createdAt: new Date().toISOString(),
      files: manifestFiles,
    };

    await this.client.put(
      this.getManifestName(),
      Buffer.from(JSON.stringify(manifest)),
      {
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json',
        },
      },
    );
  };

  assertValidManifest = (manifest, objectName) => {
    const namespacePrefix = `${this.config.ossNamespace}/`;
    const manifestPrefix = `${this.getManifestPrefix()}/`;
    const hasInvalidFile = !Array.isArray(manifest.files) || manifest.files.some(file => (
      typeof file !== 'string'
      || !file.startsWith(namespacePrefix)
      || file.startsWith(manifestPrefix)
    ));

    if (
      manifest.version !== 1
      || typeof manifest.releaseName !== 'string'
      || !dayjs(manifest.createdAt).isValid()
      || hasInvalidFile
    ) {
      throw new Error(`Invalid OSS release manifest: ${objectName}`);
    }
  };

  getVersionManifests = async () => {
    const manifestObjects = await this.listAllObjects(`${this.getManifestPrefix()}/`);
    const manifests = [];

    for (const object of manifestObjects) {
      try {
        const result = await this.client.get(object.name);
        const manifest = JSON.parse(result.content.toString());
        this.assertValidManifest(manifest, object.name);
        manifests.push({
          ...manifest,
          objectName: object.name,
        });
      } catch (error) {
        const wrappedError = new Error(`Failed to read OSS release manifest; cleanup aborted: ${object.name}`);
        wrappedError.cause = error;
        throw wrappedError;
      }
    }

    return manifests.sort((a, b) => dayjs(b.createdAt).diff(dayjs(a.createdAt)));
  };

  deleteObjects = async (names) => {
    for (let index = 0; index < names.length; index += DELETE_BATCH_SIZE) {
      await this.client.deleteMulti(names.slice(index, index + DELETE_BATCH_SIZE));
    }
  };

  clearOldVersionFiles = async () => {
    console.log('开始清理OSS旧版本文件...');
    const manifests = await this.getVersionManifests();
    const saveVersion = this.config.versionsRetainedNumber;

    // Existing deployments have no manifests. Wait until a complete retention
    // window has been recorded before pruning to avoid deleting legacy chunks.
    if (manifests.length <= saveVersion) {
      console.log(`已有 ${manifests.length} 个OSS发布清单，达到 ${saveVersion + 1} 个后开始清理`);
      return;
    }

    const retainedManifests = manifests.slice(0, saveVersion);
    const expiredManifests = manifests.slice(saveVersion);
    const retainedFiles = new Set(retainedManifests.flatMap(manifest => manifest.files));
    const expiredFiles = new Set(expiredManifests.flatMap(manifest => manifest.files));
    const obsoleteFiles = [...expiredFiles].filter(file => !retainedFiles.has(file));

    if (obsoleteFiles.length) {
      console.log(`将从OSS删除 ${obsoleteFiles.length} 个不再被保留版本引用的文件`);
      await this.deleteObjects(obsoleteFiles);
    }

    await this.deleteObjects(expiredManifests.map(manifest => manifest.objectName));
    console.log('清理OSS旧版本文件完成');
  };

  generateChecksum = async (filePath) => {
    const data = await fs.readFile(filePath);
    return crypto.createHash('md5').update(data).digest('hex');
  };

  uploadFile = async (fileName, filePath) => {
    const checksum = await this.generateChecksum(filePath);
    const upload = async () => {
      console.log(`正在上传文件: ${filePath}`);
      await this.client.put(fileName, filePath, { meta: { checksum } });
    };
    return this.client.head(fileName)
      .then(({ meta }) => {
        if (_.get(meta, 'checksum') !== checksum) {
          return upload();
        }
      })
      .catch((e) => {
        if (e.status === 404) {
          return upload();
        }
        throw e;
      });
  };

  run = async () => {
    const allFiles = await this.getFiles();
    const files = allFiles.filter(item => fs.lstatSync(item).isFile());

    const fileList = files.sort().map(item => ({
      filePath: item,
      fileName: this.getObjectName(item),
    }));
    if (fileList.length === 0) {
      throw new Error(`No files matched OSS upload pattern: ${this.config.ossPattern}`);
    }

    console.log('上传到OSS...');
    await async.eachLimit(fileList, 10, async (item) => {
      await this.uploadFile(item.fileName, item.filePath);
    });
    console.log('上传到OSS完成');
    await this.uploadVersionManifest(fileList.map(item => item.fileName));
    if (this.config.ossClearLocalFile) {
      console.log('清理dist目录...');
      await Promise.all(files.map(item => fs.remove(item)));
      console.log('清理dist目录完成');
    }
    await this.clearOldVersionFiles();
  };

  static deploy = async (config = {}) => {
    const instance = new this(config);
    await instance.run();
  };
}

module.exports = DeployAliOss;
