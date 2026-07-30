# node-deploy
- [使用方式](#使用方式)
- [参数说明](#参数说明)
- [h5 项目参考配置](#h5-项目参考配置)
- [admin 项目参考配置](#admin-项目参考配置)
- [服务器目录说明](#服务器目录说明)
- [只需要上传到阿里云 OSS](#只需要上传到阿里云-oss)
- [只需要上传到腾讯云 COS](#只需要上传到腾讯云-cos)
- [afterUpload 示例](#afterupload-示例)

### 使用方式
```javascript
  const { DeployToOss, DeployToCos, deploy, NodeSSH } = require('node-deploy');
  deploy({
    // 同时上传到云存储和服务器配置
    // 根据配置参数自动判断使用阿里云OSS还是腾讯云COS
    // .......
  });

  DeployToOss.deploy({
    // 只上传阿里云 OSS
    // .......
  });

  DeployToCos.deploy({
    // 只上传腾讯云 COS
    // .......
  });

  NodeSSH.deploy({
    // 只上传服务器
    // .......
  });
```

### 参数说明
```javascript
module.exports = {
  // 阿里云OSS相关配置
  ossAccessKeyId,                                      // oss accessKeyId
  ossAccessKeySecret,                                  // oss accessKeySecret
  ossBucket,                                           // oss bucket
  ossEndpoint,                                         // oss endpoint
  ossTimeout,                                          // （选填）上传 oss 的超时时间, 默认: '600s'
  ossNamespace,                                        // （选填）oss 上传文件夹，默认: 'frontend'
  ossPattern,                                          // （选填）需要上传oss的文件，默认: `${path.resolve('dist')}/**/*.!(html)`
  releaseName,                                         // （选填）OSS 发布清单名称，也兼容 release_name

  // 腾讯云COS相关配置
  cosSecretId,                                         // cos SecretId
  cosSecretKey,                                        // cos SecretKey
  cosBucket,                                           // cos Bucket
  cosRegion,                                           // cos Region
  cosNamespace,                                        // （选填）cos 上传文件夹，默认: 'frontend'
  cosPattern,                                          // （选填）需要上传cos的文件，默认: `${path.resolve('dist')}/**/*.!(html)`
  ossClearLocalFile,                                   // （选填）删除成功上传到 OSS 的本地文件`

  versionsRetainedNumber,                              // （选填）需要保留的版本数量, 默认 1

  // 以下为上传服务器的配置
  project_dir: '/var/www/xxx-frontend',                // 服务器中项目的文件夹路径
  namespace: 'app',                                    // 命名空间
  release_name: dayjs().format('YYYY-MM-DD_HH_mm'),    // 版本名称
  local_target: path.resolve('dist'),                  // uni-app build 后，打包文件的所在位置
  tar: false,                                          // 不开启压缩上传
  localOnly: false,                                    // （选填）本地打包模式，只生成 tar 包不上传服务器，默认: false
  includes: [],                                        // （选填）只打包匹配的文件/目录，支持 glob 语法，默认: ['**/*']
  excludes: [],                                        // （选填）排除匹配的文件/目录，支持 glob 语法，默认: []
  globOptions: {},                                     // （选填）自定义 glob 选项，如 { maxDepth: 3 }，默认: {}
  afterUpload(ssh): Promise<void>,                     // （选填）执行完上传后的回调函数，参考下方 afterUpload 示例
  ssh_configs: [
    {
      host: '0.0.0.0',                                 // 跳板服务器 ip
      port: '22',                                      // (选填) 默认为 22
      forwardOut: {
        host: '0.0.0.0',                               // 实际服务器 ip
      }
    },
  ]
}
```

阿里云 OSS 会为每次上传写入发布清单，并保留最近 `versionsRetainedNumber` 次发布仍然引用的文件。只有文件不再被任何保留清单引用时才会删除，因此可安全处理 Nuxt/Vite 生成的 hash-only chunk。首次启用发布清单时会将 namespace 内的现存对象纳入基线，并先积累完整的保留窗口，再开始清理旧文件。

#### Glob 语法说明

`includes` 和 `excludes` 参数使用 [glob](https://www.npmjs.com/package/glob) 语法进行文件匹配：

```javascript
{
  // 排除特定目录
  excludes: [
    'node_modules/**',      // 排除根目录的 node_modules
    '**/node_modules/**',   // 排除所有层级的 node_modules
    '.git/**',              // 排除 .git 目录
    '**/.DS_Store',         // 排除所有 .DS_Store 文件
    '*.log',                // 排除根目录的所有 .log 文件
  ],

  // 只打包特定文件
  includes: [
    'dist/**',              // 只打包 dist 目录
    'public/**',            // 只打包 public 目录
    '*.html',               // 只打包根目录的 HTML 文件
  ],
}
```

**高级选项：自定义 glob 行为**

通过 `globOptions` 可以自定义 glob 的行为，支持所有 [glob](https://www.npmjs.com/package/glob) 库的选项：

```javascript
{
  globOptions: {
    follow: true,           // 跟随符号链接（默认为 false，如需要上传 node_modules 等符号链接目录时可设为 true）
    // 更多选项请参考 glob 文档
  },
}
```

**注意事项：**
- 使用 `localOnly: true` 时，会自动将 `build.tar.gz` 添加到 `excludes`，避免循环打包
- `globOptions` 中的选项会覆盖默认配置

#### 本地打包模式（localOnly）

如果只需要在本地生成 tar 包，而不需要上传到服务器，可以使用 `localOnly` 选项：

```javascript
const { NodeSSH } = require('node-deploy');

NodeSSH.deploy({
  localOnly: true,                          // 开启本地打包模式
  tar: true,                                // 必须开启 tar 压缩
  local_target: path.resolve('dist'),       // 需要打包的目录
  includes: ['**/*'],                       // （选填）只打包匹配的文件
  excludes: ['node_modules/**', '.git/**'], // （选填）排除匹配的文件
  // 不需要配置 ssh_configs（即使配置了也不会上传）
});
```

使用 `localOnly` 模式时：
- 会在项目根目录生成 `build.tar.gz` 文件
- **自动排除 `build.tar.gz`**，避免重复运行时循环打包
- 自动显示打包内容预览（前 50 个文件）
- **不会上传到服务器**（即使配置了 `ssh_configs` 也不会上传）
- 适用于需要手动部署或传输打包文件的场景

### h5 项目参考配置
```javascript
const dayjs = require('dayjs')
const path = require('path')

module.exports = {
  // 阿里云OSS配置
  ossAccessKeyId: OSS_ACCESS_KEY_ID,
  ossAccessKeySecret: OSS_ACCESS_KEY_SECRET,
  ossBucket: OSS_BUCKET,
  ossEndpoint: OSS_ENDPOINT,
  ossNamespace: OSS_ASSETS_NAMESPACE,

  // 以下为上传服务器的配置
  project_dir: '/var/www/xxx-frontend', // 服务器中项目的文件夹路径
  namespace: 'app', // 命名空间
  release_name: dayjs().format('YYYY-MM-DD_HH_mm'), // 版本名称
  local_target: path.resolve('dist/build/h5'), // uni-app build 后，打包文件的所在位置
  tar: false, // 不开启压缩上传
  ssh_configs: {
    staging: [
      {
        host: '0.0.0.0', // 服务器 ip，支持多台服务器
        // port: '22', 默认为 22，可以不填写
      },
    ],
    production: [
      {
        host: '0.0.0.0', // 跳板服务器 ip
        port: '44433',
        forwardOut: {
          host: '0.0.0.0', // 实际服务器 ip
        }
      },
    ]
  }[process.env.NODE_ENV]
}
```

### admin 项目参考配置
```javascript
const moment = require('moment')
const path = require('path')

module.exports = {
  // 腾讯云COS配置
  cosSecretId: COS_SECRET_ID,
  cosSecretKey: COS_SECRET_KEY,
  cosBucket: COS_BUCKET,
  cosRegion: COS_REGION,
  cosNamespace: COS_ASSETS_NAMESPACE,

  // 以下为上传服务器的配置
  project_dir: '/var/www/xxx-frontend',
  namespace: 'admin',
  release_name: moment().format('YYYY-MM-DD_HH_mm'),
  local_target: path.resolve('dist'), // vue-cli build 后，打包文件的所在位置
  tar: true, // 开启压缩上传
  ssh_configs: {
    staging: [
      {
        host: '0.0.0.0', // 服务器 ip，支持多台服务器
        // port: '22', 默认为 22，可以不填写
      },
    ],
    production: [
      {
        host: '0.0.0.0', // 跳板服务器 ip，没有跳板则参考 staging 的配置
        port: '44433',
        forwardOut: {
          host: '0.0.0.0', // 实际服务器 ip
        }
      },
    ]
  }[process.env.NODE_ENV]
}
```

### 服务器目录说明
```
h5 和 admin 都部署时，服务器的目录结构('/var/www/xxx-frontend')
.
├── admin -> /var/www/xxx-frontend/admin-releases/2020-03-20_11_07 //admin 文件是一个软链接，指向admin的最新版本
├── admin-releases
│   ├── 2020-03-17_11_51
│   ├── 2020-03-17_11_56
│   ├── 2020-03-17_15_14
│   ├── 2020-03-17_18_13
│   └── 2020-03-20_11_07
├── app -> /var/www/xxx-frontend/app-releases/2020-03-20_18_53 //app 文件是一个软链接，指向app的最新版本
└── app-releases
    ├── 2020-03-19_11_14
    ├── 2020-03-20_10_50
    ├── 2020-03-20_10_59
    ├── 2020-03-20_11_41
    └── 2020-03-20_18_53
```

### 只需要上传到阿里云 OSS
```javascript
const { DeployToOss } = require('node-deploy');

// 上传到阿里云 OSS
DeployToOss.deploy({
  ossAccessKeyId: OSS_ACCESS_KEY_ID,
  ossAccessKeySecret: OSS_ACCESS_KEY_SECRET,
  ossBucket: OSS_BUCKET,
  ossEndpoint: OSS_ENDPOINT,
  ossNamespace: OSS_ASSETS_NAMESPACE,   // 选填，默认 'frontend'
  ossPattern: `${path.resolve('dist')}/**/*.!(html)`,   // 选填，规则参考 https://www.npmjs.com/package/glob
  ossTimeout: '600s',                  // 选填
  releaseName: dayjs().format('YYYY-MM-DD_HH_mm_ss'),  // 选填，也兼容 release_name
  versionsRetainedNumber: 5,           // 选填，默认保留 1 次发布
});
```

### 只需要上传到腾讯云 COS
```javascript
const { DeployToCos } = require('node-deploy');

// 上传到腾讯云 COS
DeployToCos.deploy({
  cosSecretId: COS_SECRET_ID,
  cosSecretKey: COS_SECRET_KEY,
  cosBucket: COS_BUCKET,
  cosRegion: COS_REGION,
  cosNamespace: COS_ASSETS_NAMESPACE,     // 选填，默认 'frontend'
  cosPattern: `${path.resolve('dist')}/**/*.!(html)`,   // 选填，规则参考 https://www.npmjs.com/package/glob
  versionsRetainedNumber: 3,             // 选填，默认保留1个版本
});
```

### afterUpload 示例
有时上传完文件后需要执行一些命令，比如安装依赖、重启服务器等，可以在 afterUpload 中执行。
afterUpload 必须返回 Promise 对象，否则可能会被提前关闭。
注意：使用 requestShell 执行的命令，报错不会退出，需要自行确保命令正确。

```javascript
NodeSSH.deploy({
  // ... 其他配置
  afterUpload: async (ssh) => {
    // https://github.com/steelbrain/node-ssh/issues/410
    // ssh.execCommand 和 ssh.exec 命令执行的环境不太一样。所以需要使用 requestShell。
    const shell = await ssh.requestShell();
    return new Promise(resolve => {
      shell.on('data', (data) => {
        console.log(data.toString());
      })
      shell.on('close', () => {
        resolve();
      })
      // 所有 write 命令最后，都需要加上 \n, 否则命令不会执行
      shell.write('cd /var/www/xxxx && pnpm install\n');
      // ...... 其他命名操作
      // 退出 shell
      shell.write('exit\n');
    })
  },
});
```
