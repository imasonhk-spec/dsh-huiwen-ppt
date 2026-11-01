"""Root-only, journaled physical resource switching. No weight edits or model deletion.
CLI arguments are fixed enum values; the HTTP gateway cannot pass commands/paths.
"""
import argparse
import fcntl
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import select
import signal
import socket
import stat
import subprocess
import time
import urllib.request

BASE = Path('/var/lib/dsh-huiwen-agron')
STATE = BASE / 'state.json'
CONFIG = Path('/etc/dsh-huiwen-agron.json')
CAPACITY = json.loads(Path(__file__).with_name('capacity.json').read_text())
NAME = 'huiwen-2-agron'
MAIN = 'dsh-occamy-rocm'
CONTAINERS = [MAIN, 'ollama-host', 'ollama-host-old', 'ollama-qwen', 'ollama-rocm-latest', 'ollama']
UNITS = ['dsh-ollama-luna-keepwarm.timer', 'dsh-ollama-luna-keepwarm.service', 'llama-swap.service']
INFERENCE_PORTS = {11434, 11436, 11437, 11438, 11439, 18080, 18091, 18092, 8080, 8082}
GATE_TABLE = 'dsh_inference_gate'
PROBE_MARK = 0x445348
ORIGINAL_BIN = '/home/lgsj/ROCmFPX/build-strix-rocmfp4/bin/llama-server'
RESTORE_UNIT = 'huiwen-agron-restored-27b.service'


def run(args, timeout=90, input=None):
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout, input=input).stdout.strip()


def save(state):
    BASE.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = STATE.with_suffix('.pending')
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2))
    tmp.chmod(0o600)
    tmp.replace(STATE)


def load():
    return json.loads(STATE.read_text()) if STATE.exists() else {'phase': 'ollama'}


def fetch(url, key=None, payload=None, timeout=10):
    headers = {'Connection': 'close'}
    if key:
        headers['Authorization'] = 'Bearer ' + key
    data = None
    if payload is not None:
        headers['Content-Type'] = 'application/json'
        data = json.dumps(payload).encode()
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers), timeout=timeout) as resp:
        return json.load(resp)


def inspect(name):
    p = subprocess.run(['docker', 'inspect', name], capture_output=True, text=True, timeout=20)
    if p.returncode:
        if 'no such' in p.stderr.lower():
            return None
        raise RuntimeError('Docker inspection failed: ' + p.stderr.strip()[:1000])
    return json.loads(p.stdout)[0]


def network_identities():
    path = BASE / 'network-identities.json'
    if not path.exists():
        return {}
    entry = path.lstat()
    if not stat.S_ISREG(entry.st_mode) or entry.st_uid != 0 or entry.st_mode & 0o077:
        raise RuntimeError('Network identity registry must be a root-owned private regular file')
    identities = json.loads(path.read_text())
    if not isinstance(identities, dict):
        raise RuntimeError('Invalid network identity registry')
    return identities


def fixed_mac(obj, info, attachment):
    mac = obj.get('Config', {}).get('MacAddress')
    declared = network_identities().get(obj.get('Id'), {}).get(info.get('Id'))
    if declared:
        fixed = attachment.get('IPAMConfig') or {}
        declared_ipv6, fixed_ipv6 = declared.get('ipv6'), fixed.get('IPv6Address')
        if info.get('EnableIPv6') is False:
            # Docker29 omits empty IPv6 IPAM fields on IPv4-only endpoints.
            ipv6_matches = all(value in (None, '') for value in
                               (declared_ipv6, fixed_ipv6, attachment.get('GlobalIPv6Address')))
        else:
            ipv6_matches = declared_ipv6 == fixed_ipv6
            if info.get('EnableIPv6'):
                ipv6_matches = bool(declared_ipv6 and fixed_ipv6) and ipv6_matches
        if declared.get('ipv4') != fixed.get('IPv4Address') or not ipv6_matches:
            raise RuntimeError('Network identity declaration does not match fixed IPAM addresses')
        mac = declared.get('mac')
    if mac:
        parts = mac.split(':')
        if len(parts) != 6 or any(len(part) != 2 or any(c not in '0123456789abcdefABCDEF' for c in part) for part in parts) or int(parts[0], 16) & 1 or int(''.join(parts), 16) == 0:
            raise RuntimeError('Invalid declared unicast MAC')
        mac = mac.lower()
    return mac


def record_network_identity(container_id, network_id, identity):
    identities = network_identities()
    identities.setdefault(container_id, {})[network_id] = identity
    BASE.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = BASE / 'network-identities.json'
    pending = path.with_suffix('.pending')
    pending.write_text(json.dumps(identities, indent=2))
    pending.chmod(0o600)
    pending.replace(path)


def active(unit):
    return run(['systemctl', 'show', unit, '-p', 'ActiveState', '--value']) == 'active'


def find_original():
    rows = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        try:
            args = [x.decode() for x in (proc / 'cmdline').read_bytes().split(b'\0') if x]
            if args and args[0] == ORIGINAL_BIN and '18080' in args:
                rows.append({'pid': int(proc.name), 'args': args, 'cwd': str((proc / 'cwd').resolve())})
        except (OSError, UnicodeError):
            pass
    if len(rows) > 1:
        raise RuntimeError('Multiple original 27B workers; refusing ambiguous switching')
    return rows[0] if rows else None


def connections(text, ports=INFERENCE_PORTS):
    for line in text.splitlines():
        cols = line.split()
        if cols and cols[0] in {'TIME-WAIT', 'LISTEN', 'CLOSED'}:
            continue
        for endpoint in cols[-2:]:
            try:
                if int(endpoint.rsplit(':', 1)[1]) in ports:
                    return True
            except ValueError:
                pass
    return False


def namespace_prefix(row):
    if row['pid'] == 0:
        if Path('/proc/self/ns/net').stat().st_ino != row['inode']:
            raise RuntimeError('Controller network namespace changed; recover in the original host namespace')
        return []
    # Docker stop can remove the recorded PID while a sidecar retains its netns.
    candidates = [Path('/proc') / str(row['pid']), *Path('/proc').iterdir()]
    for proc in candidates:
        if not proc.name.isdigit():
            continue
        try:
            if (proc / 'ns/net').stat().st_ino == row['inode']:
                return ['nsenter', '-t', proc.name, '-n']
        except FileNotFoundError:
            pass
    return None  # No process retains this namespace, so its rules no longer exist.


def freeze_admission(state, containers):
    rows = list(state.get('admission', []))
    endpoints = set(tuple(value) for value in state.get('admission_endpoints', []))
    macs = set(state.get('admission_macs', []))
    for original in [find_original(), state.get('recovery', {}).get('original')]:
        if not original:
            continue
        args = original.get('args', [])
        address = args[args.index('--host') + 1] if '--host' in args else '127.0.0.1'
        parsed = ipaddress.ip_address(address)
        address = str(parsed)
        if address == '::' or getattr(parsed, 'ipv4_mapped', None):
            raise RuntimeError('Ambiguous dual-stack original listener; explicit host endpoint required before switching')
        endpoints.add((str(ipaddress.ip_address(address)), 18080))
    rows.append({'pid': 0, 'inode': Path('/proc/self/ns/net').stat().st_ino})
    for name in containers:
        obj = inspect(name)
        if not obj:
            continue
        network_mode = obj['HostConfig']['NetworkMode']
        if network_mode in {'host', 'none'}:
            if network_mode == 'host':
                raise RuntimeError('Host-network inference container requires explicit endpoint inventory; refusing switch')
        elif network_mode.startswith('container:'):
            raise RuntimeError('Shared container network requires explicit ownership; refusing switch')
        settings = obj.get('NetworkSettings', {})
        if network_mode != 'none' and not settings.get('Networks'):
            raise RuntimeError('Managed container network attachments are unknown; refusing switch')
        bindings = settings.get('Ports') or obj['HostConfig'].get('PortBindings', {})
        for port, targets in bindings.items():
            if port.endswith('/tcp') and int(port.split('/')[0]) in INFERENCE_PORTS:
                for target in targets or []:
                    address = str(ipaddress.ip_address(target['HostIp'] or '0.0.0.0'))
                    endpoints.add((address, int(target['HostPort'])))
        for network, attachment in (settings.get('Networks', {}) if network_mode != 'none' else {}).items():
            info = json.loads(run(['docker', 'network', 'inspect', network]))[0]
            if info['Driver'] != 'bridge':
                raise RuntimeError('Only owned bridge endpoints are supported; refusing switch')
            fixed = attachment.get('IPAMConfig') or {}
            ipv4, ipv6 = fixed.get('IPv4Address'), fixed.get('IPv6Address')
            if not ipv4 or info.get('EnableIPv6') and not ipv6:
                raise RuntimeError('Static managed container addresses required before switching; no network changes attempted')
            addresses = [ipv4, ipv6, attachment.get('IPAddress'), attachment.get('GlobalIPv6Address')]
            # Stable MAC also covers future link-local IPv6 after namespace replacement.
            mac = fixed_mac(obj, info, attachment)
            if info.get('EnableIPv6') and not mac:
                raise RuntimeError('IPv6 bridge requires an explicitly fixed container MAC before switching')
            if info.get('EnableIPv6') and (len(settings['Networks']) != 1 or obj['State']['Running'] and attachment.get('MacAddress', '').lower() != mac):
                raise RuntimeError('IPv6 endpoint fixed MAC identity is not provable; refusing switch')
            if mac:
                macs.add(mac)
            for address in filter(None, addresses):
                address = str(ipaddress.ip_address(address))
                endpoints.update((address, port) for port in INFERENCE_PORTS)
        if obj['State']['Running'] and network_mode != 'host':
            pid = obj['State']['Pid']
            rows.append({'pid': pid, 'inode': Path(f'/proc/{pid}/ns/net').stat().st_ino})
    rows = list({row['inode']: row for row in rows}.values())
    state['admission'] = rows
    state['admission_endpoints'] = sorted(endpoints)
    state['admission_macs'] = sorted(macs)
    save(state)  # Recovery knows every possibly installed gate before any nft mutation.
    ports = ', '.join(str(port) for port in sorted(INFERENCE_PORTS))
    for row in rows:
        prefix = namespace_prefix(row)
        if prefix is None:
            continue
        tables = json.loads(run([*prefix, 'nft', '-j', 'list', 'tables']))
        families = ['inet', 'bridge'] if row['pid'] == 0 else ['inet']
        existing = {item['table']['family'] for item in tables['nftables'] if item.get('table', {}).get('name') == GATE_TABLE}
        script = ''.join(f'delete table {family} {GATE_TABLE}\n' for family in families if family in existing)
        for family in families:
            script += f'add table {family} {GATE_TABLE}\n'
            hooks = ['input', 'output', 'forward'] if family == 'inet' else ['forward', 'output']
            for hook in hooks:
                script += f'add chain {family} {GATE_TABLE} {hook} {{ type filter hook {hook} priority -10; policy accept; }}\n'
                script += f'add rule {family} {GATE_TABLE} {hook} meta mark {PROBE_MARK} accept\n'
                # Bridge reject support is optional in kernels; dropping only SYN preserves existing calls.
                verdict = 'drop' if family == 'bridge' else 'reject with tcp reset'
                matches = []
                if row['pid'] != 0:
                    # Input includes loopback, but must not gate unrelated outbound services.
                    if hook == 'input':
                        matches.append(f'meta l4proto tcp tcp dport {{ {ports} }}')
                else:
                    for address, port in sorted(endpoints):
                        version = ipaddress.ip_address(address).version
                        proto = 'ip' if version == 4 else 'ip6'
                        if family == 'bridge' and address in {'0.0.0.0', '::'}:
                            continue  # Routed local host traffic is gated by inet input/output.
                        target = f'{proto} daddr {address}' if address not in {'0.0.0.0', '::'} else f'meta nfproto {"ipv4" if version == 4 else "ipv6"} fib daddr type local'
                        matches.append(f'{target} meta l4proto tcp tcp dport {port}')
                    if family == 'bridge':
                        matches.extend(f'ether daddr {mac} meta l4proto tcp tcp dport {{ {ports} }}' for mac in sorted(macs))
                for match in matches:
                    script += f'add rule {family} {GATE_TABLE} {hook} {match} tcp flags & (syn | ack) == syn {verdict}\n'

        # nft applies this replacement atomically: never open a check/stop gap.
        run([*prefix, 'nft', '-f', '-'], input=script)


def thaw_admission(state):
    for row in state.get('admission', []):
        prefix = namespace_prefix(row)
        if prefix is None:
            continue
        tables = json.loads(run([*prefix, 'nft', '-j', 'list', 'tables']))
        for family in ['inet', 'bridge']:
            if any(item.get('table', {}).get('family') == family and item['table']['name'] == GATE_TABLE for item in tables['nftables']):
                run([*prefix, 'nft', 'delete', 'table', family, GATE_TABLE])
    state.pop('admission', None)
    state.pop('admission_endpoints', None)
    state.pop('admission_macs', None)
    save(state)


def marked_fetch(url, key=None):
    from urllib.parse import urlsplit
    target = urlsplit(url)
    if target.scheme != 'http' or target.hostname != '127.0.0.1':
        raise RuntimeError('Controller probes must use fixed loopback HTTP backends')
    conn = http.client.HTTPConnection(target.hostname, target.port, timeout=10)
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        conn.sock = sock
        sock.settimeout(10)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_MARK, PROBE_MARK)
        sock.connect((target.hostname, target.port))
        headers = {'Connection': 'close'}
        if key:
            headers['Authorization'] = 'Bearer ' + key
        conn.request('GET', target.path, headers=headers)
        resp = conn.getresponse()
        if resp.status != 200:
            raise RuntimeError('Backend readiness unavailable')
        return json.load(resp)
    finally:
        conn.close()


NETNS_PROBE = '''
import http.client, json, socket, sys
conn = None
try:
    request = json.load(sys.stdin)
    assert (request['port'], request['path']) in {(11434, '/api/version'), (8080, '/v1/models')}
    conn = http.client.HTTPConnection('127.0.0.1', request['port'], timeout=10)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    conn.sock = sock
    sock.settimeout(10)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_MARK, 0x445348)
    sock.connect(('127.0.0.1', request['port']))
    headers = {'Connection': 'close'}
    if request['key']: headers['Authorization'] = 'Bearer ' + request['key']
    conn.request('GET', request['path'], headers=headers)
    response = conn.getresponse()
    assert response.status == 200
    result = json.load(response)
except Exception:
    json.dump({'ok': False}, sys.stdout)
    sys.exit(1)
finally:
    if conn is not None: conn.close()
json.dump({'ok': True, 'result': result}, sys.stdout)
'''


def container_probe_identity(name):
    obj = inspect(name)
    if (not obj or obj.get('Name') != '/' + name or not re.fullmatch('[0-9a-f]{64}', obj.get('Id', ''))
            or not obj['State']['Running'] or obj['State'].get('Restarting')
            or type(obj['State'].get('Pid')) is not int or obj['State']['Pid'] <= 0):
        raise RuntimeError('Fixed probe container identity unavailable')
    if name == NAME:
        validate_gufo(obj)
    networks = obj.get('NetworkSettings', {}).get('Networks', {})
    mode = obj['HostConfig']['NetworkMode']
    if len(networks) != 1 or mode not in networks or mode in {'host', 'none'}:
        raise RuntimeError('Fixed probe requires its registered bridge namespace')
    info = json.loads(run(['docker', 'network', 'inspect', mode]))[0]
    attachment = networks[mode]
    declared = network_identities().get(obj['Id'], {}).get(info.get('Id'))
    if (info.get('Driver') != 'bridge' or not declared
            or not re.fullmatch('[0-9a-f]{64}', info.get('Id', ''))
            or attachment.get('NetworkID') != info['Id'] or type(info.get('EnableIPv6')) is not bool):
        raise RuntimeError('Fixed probe network identity unavailable')
    mac = fixed_mac(obj, info, attachment)
    fixed = attachment.get('IPAMConfig') or {}
    if (not mac or attachment.get('MacAddress', '').lower() != mac or not fixed.get('IPv4Address')
            or attachment.get('IPAddress') != fixed['IPv4Address']):
        raise RuntimeError('Fixed probe runtime IP or MAC identity unavailable')
    ipaddress.IPv4Address(fixed['IPv4Address'])
    if info['EnableIPv6']:
        if attachment.get('GlobalIPv6Address') != fixed.get('IPv6Address'):
            raise RuntimeError('Fixed probe runtime IPv6 identity unavailable')
        ipaddress.IPv6Address(fixed['IPv6Address'])
    return obj


def container_marked_fetch(name, key=None):
    routes = {MAIN: (11434, '/api/version'), NAME: (8080, '/v1/models')}
    if os.geteuid() != 0 or name not in routes:
        raise RuntimeError('Only fixed root container readiness probes are supported')
    obj = container_probe_identity(name)
    pid = obj['State']['Pid']
    path = f'/proc/{pid}/ns/net'
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
    try:
        inode = os.fstat(fd).st_ino
        def same_target():
            current = container_probe_identity(name)
            if (current['Id'] != obj['Id'] or current['State']['Pid'] != pid or os.stat(path).st_ino != inode):
                raise RuntimeError('Fixed probe namespace identity changed')
        same_target()
        port, endpoint = routes[name]
        # Only the isolated child enters the pinned namespace; secrets use stdin, never argv.
        try:
            result = subprocess.run(['/usr/bin/nsenter', f'--net=/proc/self/fd/{fd}', '--',
                                     '/usr/bin/python3', '-I', '-c', NETNS_PROBE],
                                    input=json.dumps({'port': port, 'path': endpoint, 'key': key}),
                                    pass_fds=(fd,), capture_output=True, text=True, timeout=15)
            if result.returncode != 0:
                raise RuntimeError('probe failed')
            value = json.loads(result.stdout)
            if value.get('ok') is not True:
                raise RuntimeError('probe failed')
        except Exception:
            raise RuntimeError('Container namespace readiness unavailable') from None
        same_target()
        return value['result']
    finally:
        os.close(fd)


def require_idle(original, containers):
    end = time.monotonic() + 45
    while True:
        # Include half-open handshakes accepted just before the admission barrier.
        # Host 11434 is the shim ingress waiting for this switch; container 11434 remains a backend.
        busy = connections(run(['ss', '-Htn', 'state', 'connected']), INFERENCE_PORTS - {11434})
        for name in containers:
            obj = inspect(name)
            if obj and obj['State']['Running'] and obj['HostConfig']['NetworkMode'] != 'host':
                text = run(['nsenter', '-t', str(obj['State']['Pid']), '-n', 'ss', '-Htn', 'state', 'connected'])
                busy = busy or connections(text)
        if original:
            try:
                slots = marked_fetch('http://127.0.0.1:18080/slots')
                busy = busy or not isinstance(slots, list) or any(s.get('is_processing') is not False for s in slots)
            except Exception:
                raise RuntimeError('Original 27B backend idle state cannot be confirmed')
        if not busy:
            return
        if time.monotonic() > end:
            raise RuntimeError('Local inference is busy; no forced interruption of active requests')
        time.sleep(1)


def stop_original(row):
    if active(RESTORE_UNIT):
        run(['systemctl', 'stop', RESTORE_UNIT], timeout=80)
        return
    pid = row['pid']
    fd = os.pidfd_open(pid)
    try:
        actual = [x.decode() for x in Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0') if x]
        if actual != row['args']:
            raise RuntimeError('Original process identity changed')
        signal.pidfd_send_signal(fd, signal.SIGTERM)
        if not select.select([fd], [], [], 60)[0]:
            raise RuntimeError('Original worker did not exit; refusing forced termination')
    finally:
        os.close(fd)


def stop_gufo():
    obj = inspect(NAME)
    if obj and obj['State']['Running']:
        run(['docker', 'stop', '--time', '60', NAME], timeout=80)
    obj = inspect(NAME)
    if obj and obj['State']['Running']:
        raise RuntimeError('Agron process has not stopped')


def restore():
    state = load()
    recovery = state.get('recovery')
    obj = inspect(NAME)
    switching = bool(recovery or state.get('admission') or obj and obj['State']['Running'])
    if switching:
        freeze_admission(state, [*CONTAINERS, NAME])
        require_idle(find_original(), [*CONTAINERS, NAME])
        stop_gufo()  # First prove the large model's process is gone.
    if recovery:
        state['phase'] = 'restoring'
        save(state)
        for name in recovery.get('containers', []):
            obj = inspect(name)
            if not obj or not obj['State']['Running']:
                run(['docker', 'start', name])
        row = recovery.get('original')
        if row and not find_original():
            run(['systemd-run', '--unit=' + RESTORE_UNIT, '--collect',
                 '--property=User=lgsj', '--property=WorkingDirectory=' + row['cwd'],
                 '--property=TimeoutStopSec=70', '--', *row['args']], timeout=30)
        for unit in reversed(recovery.get('units', [])):
            if unit.endswith('.service') and 'keepwarm' in unit:
                continue  # Restart the timer, not an old oneshot in flight.
            run(['systemctl', 'start', unit], timeout=90)
    obj = inspect(MAIN)
    if not obj or not obj['State']['Running']:
        raise RuntimeError('Ollama main backend unavailable; no unjournaled start attempted')
    end = time.monotonic() + 60
    while True:
        try:
            # This readiness probe uses the same root-only mark as /slots.
            if switching:
                container_marked_fetch(MAIN)
            else:
                fetch('http://127.0.0.1:11439/api/version')
            if recovery and recovery.get('original'):
                marked_fetch('http://127.0.0.1:18080/slots')
            break
        except Exception:
            if time.monotonic() > end:
                raise RuntimeError('Ollama readiness timeout')
            time.sleep(1)
    if switching:
        state['phase'] = 'ollama'
        state['restored_at'] = time.time()
        save(state)
        thaw_admission(state)
        state.pop('recovery', None)
        save(state)


def validate_gufo(obj):
    if obj['Config'].get('Labels', {}).get('dsh.owner') != 'huiwen-agron-v1':
        raise RuntimeError('Container name occupied by another deployment')
    args = obj['Config'].get('Cmd') or []
    for flag, expected in [('--context', CAPACITY['contextWindow']), ('--max-tokens', CAPACITY['maxOutputTokens']),
                           ('--sessions', CAPACITY['sessions']), ('--speculative', 'mtp'),
                           ('--mtp-model', '/models/huiwen-agron-mtp.gguf'), ('--draft-tokens', '7')]:
        positions = [i for i, value in enumerate(args) if value == flag]
        if len(positions) != 1 or positions[0] + 1 >= len(args) or args[positions[0] + 1] != str(expected):
            raise RuntimeError('Container capacity/MTP mismatch; drain and rebuild the owned container before activation')


def prepare_gufo(config):
    receipt = json.loads(Path(config['weight_receipt']).read_text())
    if len(receipt) != 5 or not all(r.get('sha256_verified') for r in receipt):
        raise RuntimeError('Verified complete weight receipt required')
    aliases = BASE / 'weights'
    aliases.mkdir(parents=True, exist_ok=True, mode=0o755)
    aliases.chmod(0o755)  # Image runs as uid 1000; weights are public, key is separate.
    for i, row in enumerate(receipt):
        src = Path(row['file'])
        st = src.stat()
        if (st.st_size, st.st_mtime_ns, st.st_ino) != (row['bytes'], row['mtime_ns'], row['ino']):
            raise RuntimeError('Weight changed since verification')
        dest = aliases / (f'huiwen-2-agron-Q4-{i + 1:05d}-of-00004.gguf' if i < 4 else 'huiwen-agron-mtp.gguf')
        if not dest.exists():
            os.link(src, dest)
        elif dest.stat().st_ino != st.st_ino:
            raise RuntimeError('Unexpected weight alias')
    obj = inspect(NAME)
    if obj:
        validate_gufo(obj)
        return
    network = config.get('network')
    address = config.get('ipv4')
    if not network or not address:
        raise RuntimeError('Provision a managed bridge and explicit network/ipv4 before creating Agron')
    info = json.loads(run(['docker', 'network', 'inspect', network]))[0]
    if info['Driver'] != 'bridge':
        raise RuntimeError('Agron requires a managed bridge network')
    address = str(ipaddress.IPv4Address(address))
    network_args = ['--network', network, '--ip', address]
    if info.get('EnableIPv6'):
        if not config.get('ipv6') or not config.get('mac'):
            raise RuntimeError('IPv6 Agron bridge requires explicit ipv6 and fixed mac')
        network_args += ['--ip6', str(ipaddress.IPv6Address(config['ipv6'])), '--mac-address', config['mac']]
    keypath = Path(config['key_file'])
    if not keypath.is_file() or keypath.is_symlink() or keypath.stat().st_mode & 0o077:
        raise RuntimeError('Private backend key file required')
    shell = 'IFS= read -r API_KEY < /run/agron-key; test -n "$API_KEY" || exit 2; exec gufo "$@" --api-key "$API_KEY"'
    run(['docker', 'create', '--name', NAME, '--restart', 'no', '--label', 'dsh.owner=huiwen-agron-v1',
         *network_args,
         '--memory', '112g', '--memory-swap', '112g', '--pids-limit', '512',
         '--device', '/dev/kfd', '--device', '/dev/dri', '--group-add', '992', '--group-add', '44',
         '--ulimit', 'memlock=-1:-1', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
         '--publish', '127.0.0.1:18092:8080',
         '--mount', f'type=bind,src={aliases},dst=/models,readonly',
         '--mount', f'type=bind,src={keypath},dst=/run/agron-key,readonly',
         '--entrypoint', '/bin/sh', config['image'], '-c', shell, 'agron-entry',
         'serve', 'llm', '--model', '/models/huiwen-2-agron-Q4-00001-of-00004.gguf',
         '--served-model-name', 'huiwen-2-agron:latest', '--host', '0.0.0.0', '--port', '8080',
         '--context', str(CAPACITY['contextWindow']), '--sessions', str(CAPACITY['sessions']), '--speculative', 'mtp', '--think', 'off',
         '--cache-ram-bytes', '1073741824', '--max-pending', '8', '--request-timeout-ms', '900000',
         '--max-request-bytes', '8388608', '--max-tokens', str(CAPACITY['maxOutputTokens']),
         '--mtp-model', '/models/huiwen-agron-mtp.gguf', '--draft-tokens', '7'], timeout=120)
    if info.get('EnableIPv6'):
        created = inspect(NAME)
        attachment = (created or {}).get('NetworkSettings', {}).get('Networks', {}).get(network, {})
        fixed = attachment.get('IPAMConfig') or {}
        if not created or not created.get('Id') or not info.get('Id') or (fixed.get('IPv4Address'), fixed.get('IPv6Address')) != (address, str(ipaddress.IPv6Address(config['ipv6']))):
            raise RuntimeError('Created Agron network identity cannot be confirmed; no model switch attempted')
        record_network_identity(created['Id'], info['Id'], {'ipv4': address, 'ipv6': fixed['IPv6Address'], 'mac': config['mac']})


def activate_gufo(config):
    obj = inspect(NAME)
    state = load()
    if state.get('phase') == 'gufo' and not state.get('admission') and obj and obj['State']['Running']:
        validate_gufo(obj)
        fetch('http://127.0.0.1:18092/v1/models', Path(config['key_file']).read_text().strip())
        return
    if state.get('recovery') or state.get('admission'):
        restore()
    prepare_gufo(config)  # Validate before touching existing resources.
    pool = int(Path('/sys/module/ttm/parameters/pages_limit').read_text()) * os.sysconf('SC_PAGE_SIZE')
    rocminfo = run(['/usr/bin/rocminfo'], timeout=30)
    import re
    gpu_blocks = [block for block in re.split(r'(?m)^Agent \d+\s*$', rocminfo) if re.search(r'(?m)^\s*Name:\s+gfx1151\s*$', block)]
    sizes = re.findall(r'Segment:\s+GLOBAL;[^\n]*\n\s*Size:\s+(\d+)', '\n'.join(gpu_blocks))
    if pool < 96 * 1024 ** 3 or not sizes or max(int(n) for n in sizes) * 1024 < 96 * 1024 ** 3:
        raise RuntimeError('96 GiB GPU pool prerequisite no longer met')
    units = [u for u in UNITS if active(u)]
    running = [name for name in CONTAINERS if (inspect(name) or {}).get('State', {}).get('Running')]
    original = find_original()
    state = {'phase': 'pausing', 'recovery': {'units': units, 'containers': running, 'original': original}, 'started_at': time.time()}
    save(state)  # Persist full restore inventory before any stop.
    try:
        freeze_admission(state, [*CONTAINERS, NAME])
        require_idle(original, running)
        for unit in units:
            if 'keepwarm' in unit:
                run(['systemctl', 'stop', unit], timeout=80)
        if 'llama-swap.service' in units:
            run(['systemctl', 'stop', 'llama-swap.service'], timeout=80)
        for name in running:
            run(['docker', 'stop', '--time', '60', name], timeout=80)
            if inspect(name)['State']['Running']:
                raise RuntimeError('Ollama backend did not stop')
        if original:
            stop_original(original)
        mem = {k: int(v.split()[0]) * 1024 for k, v in (line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())}
        if mem['MemAvailable'] < 96 * 1024 ** 3:
            raise RuntimeError('Less than 96 GiB host memory free after resource drain')
        if find_original():
            raise RuntimeError('Original worker reappeared; refusing load')
        workers = run(['ps', '-eo', 'comm='])
        if any('llama-server' in line or line.strip() == 'gufo' for line in workers.splitlines()):
            raise RuntimeError('An unmanaged inference worker is still active; refusing load')
        run(['docker', 'start', NAME])
        key = Path(config['key_file']).read_text().strip()
        end = time.monotonic() + 180
        while True:
            if not inspect(NAME)['State']['Running']:
                raise RuntimeError('Agron container exited during loading')
            try:
                data = container_marked_fetch(NAME, key)
                if any(m.get('id') == 'huiwen-2-agron:latest' for m in data.get('data', [])):
                    break
            except Exception:
                pass
            if time.monotonic() > end:
                raise RuntimeError('Agron readiness timeout')
            time.sleep(1)
        state['phase'] = 'gufo'
        save(state)
        thaw_admission(state)
    except BaseException:
        restore()
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['gufo', 'ollama', 'recover'])
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise RuntimeError('Root-only controller')
    os.umask(0o077)
    BASE.mkdir(parents=True, exist_ok=True)
    with (BASE / 'switch.lock').open('a') as lock:
        end = time.monotonic() + 1800
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() > end:
                    raise RuntimeError('Controller lock deadline exceeded; another switch owns resources')
                time.sleep(1)
        config = json.loads(CONFIG.read_text())
        if args.action == 'gufo':
            activate_gufo(config)
        else:
            restore()
    print(json.dumps({'phase': load()['phase']}))


if __name__ == '__main__':
    main()
