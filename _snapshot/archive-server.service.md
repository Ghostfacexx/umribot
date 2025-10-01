```
[Unit]
Description=Outnet Static Archive Server
After=network.target

[Service]
Type=simple
Environment=PORT=8080
Environment=ARCHIVE_ROOT=/var/www/outnet-archive
ExecStart=/usr/bin/node /root/SingleFile/single-file-cli/serve-archive.cjs
Restart=on-failure
WorkingDirectory=/root/SingleFile/single-file-cli
User=root
# Consider using a non-root user and readonly perms

[Install]
WantedBy=multi-user.target
```
