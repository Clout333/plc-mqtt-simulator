"""可选浏览器验收。需要 Python Playwright 和 Chromium，测试有独立端口与数据目录。"""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import urllib.request
import uuid
from playwright.sync_api import sync_playwright, expect

def available_ports():
    sockets = [socket.socket() for _ in range(3)]
    try:
        for item in sockets:
            item.bind(('127.0.0.1', 0))
        return [item.getsockname()[1] for item in sockets]
    finally:
        for item in sockets:
            item.close()

def main():
    root = Path(__file__).resolve().parents[1]
    script = """const root=process.argv[1],c=require(root+'/project.json');
c.ports=JSON.parse(process.argv[3]);require(root+'/src/server.cjs').start(root,c,{dataDir:process.argv[2],onStop:()=>process.exit(0)}).then(a=>console.log(a.instance)).catch(e=>{console.error(e);process.exit(1);});"""
    with tempfile.TemporaryDirectory(prefix='bench-browser-') as temp:
        hp, mq, mb = available_ports()
        url = 'http://127.0.0.1:' + str(hp)
        ports = json.dumps(dict(http=hp, mqtt=mq, modbus=mb))
        exe = root / 'runtime' / 'node.exe'
        proc = subprocess.Popen([str(exe) if exe.exists() else 'node','-e',script,str(root),temp,ports],stdout=subprocess.PIPE,text=True)
        try:
            token = proc.stdout.readline().strip()
            if not token:
                raise RuntimeError('临时试验台启动失败')
            with sync_playwright() as pw:
                opts = {'headless':True}
                browser_path = os.environ.get('BENCH_CHROMIUM')
                if browser_path:
                    opts['executable_path'] = browser_path
                browser = pw.chromium.launch(**opts)
                page = browser.new_page(viewport={'width':1440,'height':940})
                errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))
                launch_id=str(uuid.uuid4())
                page.goto(url+'/?launch='+launch_id)
                expect(page.locator('#plcLink')).to_have_text('通信正常')
                expect(page.locator('#ownerLink')).to_have_text('已订阅')
                page.wait_for_function("!new URL(location.href).searchParams.has('launch')")
                with urllib.request.urlopen(url+'/health?launch='+launch_id,timeout=3) as received:
                    assert json.load(received)['pageReady']
                shots = os.environ.get('BENCH_SCREENSHOTS')
                if shots:
                    Path(shots).mkdir(parents=True, exist_ok=True)
                    page.screenshot(path=str(Path(shots)/'操作面板.png'),full_page=True)
                page.locator('#key-start').click()
                expect(page.locator('#phase')).to_have_text('准备中')
                page.locator('#key-stop').click()
                expect(page.locator('#phase')).to_have_text('结束处理')
                page.locator('#advance').click()
                expect(page.locator('#phase')).to_have_text('待机')
                page.locator('#key-estop').click()
                expect(page.locator('#emergency')).to_have_text('急停按下')
                page.locator('#release').click()
                expect(page.locator('#emergency')).to_have_text('已释放')
                expect(page.locator('#fault')).to_have_text('待复位')
                page.locator('#key-reset').click()
                expect(page.locator('#fault')).to_have_text('正常')
                page.locator('#projectChoice').select_option('field')
                expect(page.locator('#key-stop')).to_be_disabled()
                expect(page.locator('[data-hmi="start"]')).to_be_disabled()
                page.locator('#key-start').click()
                expect(page.locator('#permit')).to_have_text('已使能')
                expect(page.locator('#phase')).to_have_text('待机')
                page.locator('[data-hmi="start"]').click()
                expect(page.locator('#phase')).to_have_text('准备中')
                page.locator('[data-hmi="stop"]').click()
                expect(page.locator('#phase')).to_have_text('结束处理')
                page.locator('#advance').click()
                # 切换请求完成前不能向旧项目发送命令。
                with page.expect_response(lambda r:r.url.endswith('/api/project/select')) as switched:
                    locked=page.locator('#projectChoice').evaluate("""select=>{
                        select.value='general'; select.dispatchEvent(new Event('change',{bubbles:true}));
                        return select.disabled && document.querySelector('[data-command=start]').disabled;
                    }""")
                    assert locked, '项目更新时仍能向设备发送命令'
                assert switched.value.ok
                expect(page.locator('#projectChoice option:checked')).to_have_text('通用四键台')
                page.locator('[data-command="start"]').click()
                expect(page.locator('#receipt')).to_contain_text('设备已受理')
                page.locator('[data-command="stop"]').click()
                expect(page.locator('#phase')).to_have_text('结束处理')
                page.locator('#advance').click()
                page.locator('[data-tab="buttons"]').click()
                page.locator('#newButton').click()
                page.locator('#btnName').fill('测转速')
                page.locator('#btnTopic').fill('local/speed')
                page.locator('#btnPayload').fill('{"rpm":"{{rpm}}"}')
                page.locator('#btnReply').fill('')
                page.locator('#btnValues').fill('{"rpm":900}')
                page.locator('#preview').click()
                expect(page.locator('#previewBox')).to_contain_text('"rpm":900')
                page.locator('#sendEdited').click()
                expect(page.locator('#previewBox')).to_contain_text('untracked')
                page.locator('[data-tab="frames"]').click()
                page.locator('#filter').fill('local/speed')
                row = page.locator('#allRows tr').first
                expect(row).to_contain_text('local/speed')
                row.get_by_text('查看').click()
                expect(page.locator('#dialogBody')).to_have_text('{"rpm":900}')
                page.locator('#closeDetail').click()
                page.locator('[data-tab="connect"]').click()
                page.locator('#pPlc').select_option('mitsubishi')
                page.locator('#pHmi').select_option('weintek')
                page.locator('#pOwner').select_option('gateway')
                page.locator('#projectForm button[type="submit"]').click()
                expect(page.locator('#routeText')).to_contain_text('网关模块')
                page.locator('#testScreen').uncheck()
                page.locator('[data-tab="console"]').click()
                expect(page.locator('[data-hmi="start"]')).to_be_disabled()
                page.locator('[data-command="query"]').click()
                expect(page.locator('#receipt')).to_contain_text('设备已受理')
                page.locator('[data-tab="buttons"]').click()
                page.locator('#buttonList').get_by_text('测转速').click()
                page.once('dialog',lambda d:d.accept())
                page.locator('#deleteButton').click()
                expect(page.locator('#buttonList')).not_to_contain_text('测转速')
                page.locator('#protocolOpen').click()
                with page.expect_download() as template:
                    page.locator('#protocolTemplate').click()
                template_bytes=Path(template.value.path()).read_bytes()
                assert template_bytes.startswith(b'\xef\xbb\xbf') and '方向' in template_bytes.decode('utf-8-sig')
                sample={'name':'泵站（乙） & 试验.csv','mimeType':'text/csv','buffer':template_bytes.replace(b'{{prefix}}command','/泵站/查询'.encode())}
                page.locator('#protocolFiles').set_input_files(sample)
                expect(page.locator('#protocolStatus')).to_have_text('已识别 2 条，请核对方向和内容')
                expect(page.locator('#protocolList .protocolRow')).to_have_count(2)
                page.locator('#protocolClose').click()
                expect(page.locator('#sampleList')).to_be_empty()
                page.locator('#protocolOpen').click()
                page.locator('#protocolFiles').set_input_files(sample)
                expect(page.locator('#protocolKind')).to_have_value('command')
                page.locator('#protocolName').fill('泵站查询')
                page.locator('#protocolSave').click()
                expect(page.locator('#notice')).to_contain_text('已保存 1 个按钮、1 条样例')
                expect(page.locator('#buttonList')).to_contain_text('泵站查询')
                page.locator('#sampleList').get_by_text('查询回执',exact=True).click()
                expect(page.locator('#dialogBody')).to_contain_text('已读取')
                page.locator('#closeDetail').click()
                page.reload()
                expect(page.locator('#sampleList')).to_contain_text('查询回执')
                page.locator('#protocolOpen').click()
                page.locator('#protocolFiles').set_input_files(sample)
                expect(page.locator('#protocolCount')).to_contain_text('已选 2 / 2 条')
                for width,height in ((1024,768),(390,844),(320,650)):
                    page.set_viewport_size({'width':width,'height':height})
                    dialog=page.locator('#protocolDialog')
                    assert dialog.evaluate('d=>d.scrollWidth <= d.clientWidth + 1'), '协议预览横向溢出'
                    save=page.locator('#protocolSave').bounding_box()
                    assert save and save['y']>=0 and save['y']+save['height']<=height, '保存按钮超出弹窗'
                page.locator('#protocolSave').click()
                expect(page.locator('#notice')).to_contain_text('跳过 2 条重复报文')
                page.set_viewport_size({'width':1440,'height':940})
                page.locator('[data-tab="assist"]').click()
                expect(page.locator('#asRoute option')).to_have_count(4)
                if shots:
                    page.screenshot(path=str(Path(shots)/'接入助手首页.png'),full_page=True)
                saved=page.evaluate("async()=>{const {epoch,project}=await (await fetch('/api/state')).json();return {epoch,project}}")
                for width in (320,390):
                    page.set_viewport_size({'width':width,'height':844})
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), '初次接入页面溢出'
                    entry=page.locator('#asDemo').bounding_box()
                    assert entry and entry['y']+entry['height']<=844, '首次试跑入口落在首屏外'
                if shots:
                    page.screenshot(path=str(Path(shots)/'手机接入助手.png'),full_page=True)
                page.set_viewport_size({'width':1440,'height':940})
                page.locator('#asDemo').click()
                expect(page.locator('#asOutcome')).to_have_text('连接检查通过')
                expect(page.locator('#asChecks')).to_contain_text('设备回复')
                assert page.evaluate("async()=>{const {epoch,project}=await (await fetch('/api/state')).json();return {epoch,project}}")==saved
                page.locator('#asBack2').click()
                expect(page.locator('#asStep1')).to_be_visible()
                page.locator('#asFiles').set_input_files([
                    {'name':'PLC_R1.gpc','mimeType':'application/octet-stream','buffer':b'format only'},
                    {'name':'PLC_R2.gpc','mimeType':'application/octet-stream','buffer':b'format only'},
                    {'name':'A7.hwdev','mimeType':'application/octet-stream','buffer':b'format only'}])
                expect(page.locator('#asFile-plc option')).to_have_count(3)
                expect(page.locator('#asWithPlc')).to_be_checked()
                page.locator('#asPlan').click()
                expect(page.locator('#asStatus')).to_contain_text('多个')
                page.locator('#asFile-plc').select_option(label='PLC_R2.gpc')
                page.locator('#asPlan').click()
                expect(page.locator('#asBindings')).to_contain_text('PLC_R2.gpc')
                expect(page.locator('#asBindings')).to_contain_text('A7.hwdev')
                page.set_viewport_size({'width':390,'height':844})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), '接入单窄屏溢出'
                page.set_viewport_size({'width':1440,'height':900})
                with page.expect_download() as csv:
                    page.locator('#asPoints').click()
                assert '点表' in csv.value.suggested_filename
                assert 'Version' in Path(csv.value.path()).read_text(encoding='utf-8-sig')
                page.locator('#asTarget > summary').click()
                with socket.socket() as missing:
                    missing.bind(('127.0.0.1',0))
                    missing_port=missing.getsockname()[1]
                page.locator('#asPort').fill('70000')
                page.locator('#asApply').click()
                expect(page.locator('#asStatus')).to_contain_text('端口')
                expect(page.locator('#asStep2')).to_be_visible()
                page.locator('#asPort').fill(str(missing_port))
                page.locator('#asReadTools > summary').click()
                page.locator('#asProbe').click()
                expect(page.locator('#asProbeRows')).to_contain_text('需处理')
                expect(page.locator('#asProbeRows')).to_contain_text('端口')
                page.locator('#asBack1').click()
                page.locator('#asPlan').click()
                expect(page.locator('#asPort')).to_have_value(str(missing_port))
                page.locator('#asBack1').click()
                project_dir=Path(temp)/'我的屏工程'
                project_dir.mkdir()
                (project_dir/'显示.cmtp').write_bytes(b'format only')
                page.set_viewport_size({'width':390,'height':844})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), '工程选择窄屏溢出'
                page.set_viewport_size({'width':1440,'height':900})
                page.locator('#asPath').fill(str(project_dir))
                page.locator('#asPath').fill(str(project_dir/'找不到的工程.gpc'))
                page.locator('#asPlan').click()
                expect(page.locator('#asStatus')).to_contain_text('找不到')
                expect(page.locator('#asStep1')).to_be_visible()
                expect(page.locator('#asMatches')).to_be_hidden()
                page.locator('#asPath').fill(str(project_dir))
                page.locator('#asPlan').click()
                expect(page.locator('#asBindings')).to_contain_text('显示.cmtp')
                page.locator('#asBack1').click()
                expect(page.locator('#asHmi')).to_have_value('weintek')
                expect(page.locator('#asWithPlc')).not_to_be_checked()
                page.locator('#asRole').select_option('display')
                page.locator('#asPlan').click()
                expect(page.locator('#asBindings')).to_contain_text('验屏点')
                page.locator('#asApply').click()
                expect(page.locator('#asChecks')).to_contain_text('触摸屏工程取数')
                page.locator('#asScreenStart').click()
                expect(page.locator('#asScreenForm')).to_be_visible()
                with socket.create_connection(('127.0.0.1',mb),timeout=3) as client:
                    client.sendall(bytes.fromhex('000100000006010300500001'))
                    answer=b''
                    while len(answer)<11:
                        part=client.recv(11-len(answer))
                        if not part:raise RuntimeError('验屏应答中断')
                        answer+=part
                code=int.from_bytes(answer[-2:],'big')
                assert 1000<=code<=9999
                page.locator('#asScreenNumber').fill(str(code))
                page.locator('#asConfirm').click()
                expect(page.locator('#asChecks')).to_contain_text('输入的屏上数值吻合')
                with page.expect_download() as download:
                    page.locator('#asExport').click()
                assert '检查结果' in download.value.suggested_filename
                if shots:
                    page.screenshot(path=str(Path(shots)/'接入助手验屏.png'),full_page=True)
                page.locator('#asBack2').click()
                page.locator('#asBack1').click()
                # 已经接过外部屏时，快速检查以现有配置为准，保留刚才的验屏记录。
                expect(page.locator('#asDemo')).to_have_text('检查已保存的连接')
                page.locator('#asDemo').click()
                expect(page.locator('#asChecks')).to_contain_text('输入的屏上数值吻合')
                page.locator('#asBack2').click()
                page.locator('#asRoute').select_option('demo')
                page.locator('#asPlan').click()
                page.locator('#asApply').click()
                expect(page.locator('#asOutcome')).to_have_text('连接检查通过')
                page.locator('#asAction').click()
                expect(page.locator('#console')).to_be_visible()
                page.locator('[data-tab="assist"]').click()
                assert not page.locator('#asScreenBox').is_visible()
                page.set_viewport_size({'width':390,'height':844})
                page.locator('[data-tab="diagnostics"]').click()
                expect(page.locator('#diagEnvironment')).to_contain_text('Node.js')
                with page.expect_download() as exported:
                    page.locator('#diagExport').click()
                diag_path=Path(exported.value.path())
                doc=json.loads(diag_path.read_text(encoding='utf8'))
                assert doc['format']=='industrial-bench-diagnostics/1' and any(e['kind']=='input.release' for e in doc['events'])
                assert not any(k in json.dumps(doc) for k in ['LAB001','/sim/','127.0.0.1','task_seq'])
                page.locator('#diagProblems').check()
                page.locator('#diagnostics details > summary').click()
                incoming=diag_path.read_bytes()
                page.locator('#diagFiles').set_input_files([{'name':'甲.json','mimeType':'application/json','buffer':incoming},{'name':'乙.json','mimeType':'application/json','buffer':incoming}])
                expect(page.locator('#diagTotals')).to_contain_text('2 份报告 · 1 个安装')
                expect(page.locator('#diagGroups')).to_be_visible()
                with page.expect_download() as totals:page.locator('#diagSummary').click()
                summary=json.loads(Path(totals.value.path()).read_text(encoding='utf8'))
                assert summary['duplicates']==len(doc['events']) and summary['installations']==1
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), '诊断页汇总窄屏溢出'
                for width,height in ((320,650),(390,844),(768,900),(1024,768),(1440,900)):
                    page.set_viewport_size({'width':width,'height':height})
                    for tab in ('console','assist','buttons','connect','frames','diagnostics'):
                        nav=page.locator('[data-tab="'+tab+'"]')
                        nav.click()
                        expect(nav).to_have_attribute('aria-current','page')
                        expect(page.locator('[data-tab][aria-current="page"]')).to_have_count(1)
                        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'{tab} 在 {width}px 溢出'
                        rect=nav.bounding_box()
                        assert rect and rect['x']>=0 and rect['x']+rect['width']<=width+1
                page.set_viewport_size({'width':390,'height':844})
                page.locator('[data-tab="console"]').click()
                release=page.locator('#release').bounding_box()
                assert release and release['height']>=32, '急停释放触摸区太小'
                page.reload()
                expect(page.locator('#serverLink')).to_have_text('本机服务在线')
                page.keyboard.press('Tab')
                expect(page.locator('.skipLink')).to_be_focused()
                page.keyboard.press('Enter')
                expect(page.locator('#pageTitle')).to_be_focused()
                # 中断网页轮询，旧的设备读数和写入按钮必须立即随离线状态失效。
                page.route('**/api/state',lambda route:route.abort())
                expect(page.locator('#serverLink')).to_have_text('本机服务离线',timeout=9000)
                expect(page.locator('#connectionAlert')).to_be_visible()
                for field in ('plcLink','mqttLink','ownerLink','emergency','fault','permit'):
                    expect(page.locator('#'+field)).to_have_text('未知')
                for control in ('#key-start','#key-estop','#release','[data-hmi=start]','[data-command=query]','#advance','#sendEdited','#projectChoice'):
                    expect(page.locator(control)).to_be_disabled()
                page.unroute('**/api/state')
                expect(page.locator('#serverLink')).to_have_text('本机服务在线',timeout=9000)
                expect(page.locator('#connectionAlert')).to_be_hidden()
                expect(page.locator('#key-start')).to_be_enabled()
                if shots:
                    page.screenshot(path=str(Path(shots)/'手机面板.png'),full_page=True)
                assert not errors, errors
                browser.close()
            print('浏览器通过：四键与急停释放、两种启动、屏上操作、MQTT 收发、按钮编辑/预览/删除、详情、网关独立运行、工程文件与路径识别、快捷检查不改设置、粘贴路径直接识别、错误恢复、只读试连、验屏、诊断导出、汇总去重、六页五种宽度、键盘跳转、协议保存和断线锁定恢复')
        finally:
            if proc.poll() is None:
                try:
                    record = json.loads((root/'project.json').read_text(encoding='utf8'))
                    req = urllib.request.Request(url+'/api/shutdown',data=json.dumps({'instance':token,'projectId':record['projectId']}).encode(),headers={'Content-Type':'application/json'})
                    urllib.request.urlopen(req,timeout=2).close()
                    proc.wait(timeout=6)
                except Exception:
                    proc.kill()
                    proc.wait()

if __name__ == '__main__':
    main()
