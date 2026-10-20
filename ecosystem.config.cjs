module.exports = {
  apps: [{
    name: 'z-media-workflow',
    script: 'src/server.js',
    cwd: __dirname,
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    max_memory_restart: '256M',
    watch: false,
    kill_timeout: 35000,
    shutdown_with_message: true,
    out_file: '/dev/stdout',
    error_file: '/dev/stderr',
    merge_logs: true
  }]
};
