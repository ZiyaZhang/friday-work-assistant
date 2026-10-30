#!/usr/bin/env python3
"""Save an App client secret from the operator's terminal, never chat or argv.

Only updates the two personal OAuth keys in the specified Friday .env. Does not
create a secret, change Google permissions, or restart the service.
"""
import argparse
import getpass
import json
import re
import shlex
import subprocess
import sys

REMOTE = r'''
import json, os, re, shlex, sys, tempfile
from pathlib import Path
d=json.load(sys.stdin)
assert re.fullmatch(r'[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com', d['client_id'])
assert re.fullmatch(r'[A-Za-z0-9_-]{20,256}', d['client_secret'])
p=Path(d['env_path']).expanduser().resolve()
assert p.is_file(), 'Friday .env does not exist'
old=p.read_text()
names={'FRIDAY_GOOGLE_CLIENT_ID':d['client_id'], 'FRIDAY_GOOGLE_CLIENT_SECRET':d['client_secret']}
lines=[line for line in old.splitlines() if not any(re.match(r'^\s*(?:export\s+)?'+name+r'\s*=',line) for name in names)]
new='\n'.join(lines)+'\n'+''.join(name+'='+shlex.quote(value)+'\n' for name,value in names.items())
fd,temp=tempfile.mkstemp(prefix='.google-oauth-',dir=p.parent)
try:
    os.fchmod(fd,0o600)
    with os.fdopen(fd,'w') as f:
        f.write(new); f.flush(); os.fsync(f.fileno())
    assert p.read_text()==old, 'Friday .env changed; retry'
    os.replace(temp,p)
finally:
    if os.path.exists(temp): os.unlink(temp)
print('Google personal OAuth configuration saved. Service restart required.')
'''

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', required=True)
    parser.add_argument('--client-id')
    parser.add_argument('--env-path', default='~/friday/.env')
    args = parser.parse_args()
    if not sys.stdin.isatty():
        parser.error('Run in an interactive terminal; do not pipe the secret.')
    if not args.client_id:
        args.client_id = input('Google OAuth Client ID: ').strip()
    if not re.fullmatch(r'[A-Za-z0-9_.@-]+', args.host) or args.host.startswith('-'):
        parser.error('Invalid SSH host')
    if not re.fullmatch(r'[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com', args.client_id):
        parser.error('Invalid Google OAuth Client ID')
    secret = getpass.getpass('Google OAuth client secret (input hidden): ').strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{20,256}', secret):
        parser.error('Client secret format is invalid; no change saved.')
    payload = json.dumps({'client_id': args.client_id, 'client_secret': secret, 'env_path': args.env_path})
    result = subprocess.run(['ssh', '-T', args.host, 'python3 -c '+shlex.quote(REMOTE)], input=payload, text=True, capture_output=True)
    if result.returncode:
        print('Configuration was not saved. Check the SSH host and .env path; no secret was printed.', file=sys.stderr)
        return 1
    print('已保存到 Friday 服务端，未更改 Google 权限；下次服务启动后生效。')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
