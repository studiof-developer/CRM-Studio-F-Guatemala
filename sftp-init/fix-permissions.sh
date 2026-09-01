#!/bin/bash
# Runs as root, before the SFTP server drops privileges to the erpimages user (this is
# atmoz/sftp's documented hook: any *.sh placed in /etc/sftp.d/ runs first). The chroot
# HOME itself (/home/erpimages) has to stay root-owned — OpenSSH refuses the chroot
# otherwise — but the subfolder the ERP admin actually uploads into needs to be owned by
# the sftp user, or every write fails with "Permission denied" (as it did 2026-08-31: a
# fresh Docker volume mounts owned by root by default, and nothing chowns it on its own).
chown 1001:1001 /home/erpimages/fotos_productos
