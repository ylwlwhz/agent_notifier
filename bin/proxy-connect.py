#!/usr/bin/env python3
"""HTTP CONNECT tunnel for SSH (usable as an SSH ProxyCommand).

用法（作为 SSH ProxyCommand）：
    ProxyCommand python3 /path/to/proxy-connect.py %h %p

本机所有出口必须走公司 HTTP 代理，SSH 直连不通（Network is unreachable）。
GitHub 用 ssh.github.com:443 + 本脚本经代理开 HTTP CONNECT 隧道即可 push/clone。
机器上 nc/ncat/socat/corkscrew 均缺，故用零依赖的 python3（本项目硬依赖）自实现。

代理地址按以下顺序取（首个非空即用），也可作为第 3 个命令行参数显式传入：
    https_proxy / HTTPS_PROXY / http_proxy / HTTP_PROXY / all_proxy / ALL_PROXY
支持代理 URL 里带 Basic 认证（http://user:pass@host:port）。
"""

import base64
import os
import select
import socket
import sys
from urllib.parse import urlparse

BUFSIZE = 65536


def log(msg):
    sys.stderr.write("[proxy-connect] %s\n" % msg)


def get_proxy(argv):
    if len(argv) >= 4 and argv[3]:
        return argv[3]
    for key in ("https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY",
                "all_proxy", "ALL_PROXY"):
        val = os.environ.get(key)
        if val:
            return val
    return None


def main():
    if len(sys.argv) < 3:
        log("usage: proxy-connect.py <host> <port> [proxy_url]")
        return 2

    host, port = sys.argv[1], sys.argv[2]
    proxy = get_proxy(sys.argv)
    if not proxy:
        log("no proxy found in env (https_proxy/http_proxy/...) and none passed as arg")
        return 3
    if "://" not in proxy:
        proxy = "http://" + proxy
    pu = urlparse(proxy)
    phost, pport = pu.hostname, pu.port or 3128

    try:
        sock = socket.create_connection((phost, pport), timeout=15)
    except OSError as e:
        log("cannot reach proxy %s:%s: %s" % (phost, pport, e))
        return 4

    req = "CONNECT %s:%s HTTP/1.1\r\nHost: %s:%s\r\n" % (host, port, host, port)
    if pu.username:
        creds = "%s:%s" % (pu.username, pu.password or "")
        token = base64.b64encode(creds.encode()).decode()
        req += "Proxy-Authorization: Basic %s\r\n" % token
    req += "\r\n"
    sock.sendall(req.encode())

    # Read the proxy response until the end of the header block.
    resp = b""
    while b"\r\n\r\n" not in resp:
        chunk = sock.recv(4096)
        if not chunk:
            break
        resp += chunk

    status_line = resp.split(b"\r\n", 1)[0].decode("latin-1", "replace")
    fields = status_line.split(" ")
    if len(fields) < 2 or fields[1] != "200":
        log("proxy CONNECT to %s:%s failed: %s" % (host, port, status_line))
        return 5

    stdout = sys.stdout.buffer
    # Forward any payload the proxy already sent past the header terminator.
    leftover = resp.split(b"\r\n\r\n", 1)[1] if b"\r\n\r\n" in resp else b""
    if leftover:
        stdout.write(leftover)
        stdout.flush()

    stdin_fd = sys.stdin.fileno()
    sock_fd = sock.fileno()
    try:
        while True:
            readable, _, _ = select.select([stdin_fd, sock_fd], [], [])
            if stdin_fd in readable:
                data = os.read(stdin_fd, BUFSIZE)
                if not data:
                    break
                sock.sendall(data)
            if sock_fd in readable:
                data = sock.recv(BUFSIZE)
                if not data:
                    break
                stdout.write(data)
                stdout.flush()
    except (OSError, KeyboardInterrupt):
        pass
    finally:
        try:
            sock.close()
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
