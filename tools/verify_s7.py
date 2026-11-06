"""可选的独立协议对测，Python 3.10+、python-snap7==2.1.0。仅绑定回环地址。"""
import ctypes
import socket
import subprocess
import time
from pathlib import Path
from snap7.server import Server
from snap7.type import SrvArea

def main():
    root = Path(__file__).resolve().parents[1]
    runtime = root / 'runtime' / 'node.exe'
    with socket.socket() as temporary:
        temporary.bind(('127.0.0.1', 0))
        port = temporary.getsockname()[1]
    flags = (ctypes.c_uint8 * 40)()
    words = (ctypes.c_uint8 * 200)()
    def read(i):
        return (words[2*i] << 8) | words[2*i+1]
    def put(i, val):
        words[2*i], words[2*i+1] = val >> 8, val & 255
    put(0, 1)
    put(8, 1)
    put(12, 11)
    server = Server()
    server.register_area(SrvArea.DB, 100, flags)
    server.register_area(SrvArea.DB, 101, words)
    server.start_to('127.0.0.1', port)
    proc = None
    try:
        proc = subprocess.Popen([str(runtime) if runtime.exists() else 'node', str(root / 'tests' / 's7-peer.cjs'), str(port)])
        deadline = time.monotonic() + 35
        while proc.poll() is None:
            if time.monotonic() > deadline:
                raise RuntimeError('S7 对测超时')
            valid, reply = flags[0] & 1, flags[0] & 2
            if valid and not reply:
                put(6, read(2))
                put(7, 1 if read(5) == read(12) else 13)
                words[80:112] = words[40:72]
                put(8, 3)
                flags[0] |= 34
            if not valid and reply:
                flags[0] &= 253
            time.sleep(.005)
        return proc.returncode
    finally:
        if proc and proc.poll() is None:
            proc.kill()
            proc.wait()
        server.stop()
        server.destroy()

if __name__ == '__main__':
    raise SystemExit(main())
