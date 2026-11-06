"""从 Git 中的发布文件、固定的 Windows 运行时和锁定依赖生成离线包。Python 3.10+。"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = {'README.md', 'CHANGELOG.md', 'project.json', 'package.json', 'package-lock.json'}
SOURCES = {'src', 'web', 'tests', 'tools', 'docs'}

def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))

def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()

def tracked_sources():
    raw = subprocess.check_output(['git', 'ls-files', '--cached', '-z'], cwd=ROOT)
    for name in sorted(raw.decode('utf8').rstrip('\0').split('\0')):
        relative = Path(name)
        if relative.parts[0] in SOURCES or name in ROOT_FILES or re.fullmatch(r'0[0-4]_[^/]+\.cmd', name):
            local = (ROOT / relative).resolve(strict=True)
            if not local.is_relative_to(ROOT) or not local.is_file():
                raise ValueError('发布清单含无效路径')
            yield local, name

def package(dependencies, out):
    info = read(ROOT/'package.json')
    version = info['version']
    lock = read(ROOT/'package-lock.json')
    if not re.fullmatch(r'\d+\.\d+\.\d+', version) or lock['version'] != version or lock['packages']['']['version'] != version:
        raise ValueError('package.json 与锁文件版本不一致')
    if not re.search(r'^## '+re.escape(version)+r' · \d{4}-\d{2}-\d{2}$', (ROOT/'CHANGELOG.md').read_text(encoding='utf8'),re.M):
        raise ValueError('请先填写本次版本更新')
    runtime = ROOT/'runtime'/'node.exe'
    if sha(runtime) != info['portableRuntime']['windowsX64Sha256']:
        raise ValueError('Windows x64 Node.js 与固定校验值不符')
    license_file = ROOT/'runtime'/'LICENSE-node.txt'
    if not license_file.is_file():
        raise ValueError('缺少 Node.js 及其第三方许可证')
    installed = read(dependencies/'.package-lock.json')['packages']
    # 离线包面向 Windows x64。锁文件同时列出了其他系统的可选 PDF 原生库。
    def for_windows_x64(entry):
        return all(target in entry.get(key, [target]) for key, target in [('os', 'win32'), ('cpu', 'x64')])
    expected = {k:v for k,v in lock['packages'].items() if k and (not v.get('optional') or for_windows_x64(v))}
    if installed.keys() != expected.keys() or any(installed[k].get('integrity')!=v.get('integrity') or installed[k]['version']!=v['version'] for k,v in expected.items()):
        raise ValueError('依赖与锁文件不符，请重新 npm ci')
    sources = list(tracked_sources())
    subprocess.run(['git','diff','--quiet','--',*[n for _,n in sources]],cwd=ROOT,check=True)
    if not {'src/server.cjs','web/index.html','04_导出诊断.cmd'}.issubset(n for _,n in sources):
        raise ValueError('请先在 Git 中暂存完整发布源码')
    sources += [(runtime,'runtime/node.exe'), (license_file,'runtime/LICENSE-node.txt')]
    for p in sorted(dependencies.rglob('*')):
        if p.is_file():
            if p.is_symlink() or not p.resolve().is_relative_to(dependencies):
                raise ValueError('依赖路径超出目录')
            sources.append((p,'node_modules/'+p.relative_to(dependencies).as_posix()))
    out.mkdir(parents=True,exist_ok=True)
    name = 'plc-mqtt-simulator-v'+version+'-windows-x64.zip'
    target = out/name
    checksum = out/(name+'.sha256')
    if target.exists() or checksum.exists():
        raise FileExistsError('此版本已经打包，请用空目录复建或增加版本号')
    # 所有包内时间固定，内容采用发布目录白名单，统一校验后写入成品。
    with tempfile.TemporaryDirectory(prefix='bench-pack-',dir=out) as build:
        work=Path(build).resolve()
        if work.parent!=out or not work.name.startswith('bench-pack-'):
            raise ValueError('无效打包目录')
        temporary=work/name
        with ZipFile(temporary,'x',ZIP_DEFLATED) as archive:
            for p,relative in sorted(sources,key=lambda item:item[1]):
                asset=ZipInfo('plc-mqtt-simulator/'+relative,(2020,1,1,0,0,0))
                asset.compress_type=ZIP_DEFLATED
                asset.external_attr=0o644 << 16
                with p.open('rb') as source,archive.open(asset,'w') as dest:
                    shutil.copyfileobj(source,dest)
        with ZipFile(temporary) as check:
            if check.testzip(): raise ValueError('ZIP 校验失败')
        digest=sha(temporary)
        temporary.rename(target)
        checksum.write_text(digest+'  '+name+'\n',encoding='ascii')
    print(str(target)+'\n'+digest)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out',type=Path,default=ROOT/'dist')
    parser.add_argument('--dependencies',type=Path,help='已经按当前锁文件执行 npm ci 的 node_modules 目录')
    args=parser.parse_args()
    if args.dependencies:
        package(args.dependencies.resolve(strict=True),args.out.resolve())
        return
    scratch=Path(tempfile.gettempdir()).resolve()
    with tempfile.TemporaryDirectory(prefix='bench-deps-',dir=scratch) as folder:
        stage=Path(folder).resolve()
        if stage.parent!=scratch or not stage.name.startswith('bench-deps-'):raise ValueError('无效依赖目录')
        for name in ['package.json','package-lock.json']:shutil.copyfile(ROOT/name,stage/name)
        npm=shutil.which('npm.cmd') or shutil.which('npm')
        if not npm:raise ValueError('请安装 npm，或指定干净的依赖目录')
        subprocess.run([npm,'ci','--ignore-scripts','--no-audit','--no-fund'],cwd=stage,check=True)
        package(stage/'node_modules',args.out.resolve())

if __name__=='__main__':
    main()
