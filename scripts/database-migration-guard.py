#!/usr/bin/env python3
"""Offline SQLite migration guard. No product startup, network or plaintext business output."""
import argparse
import base64
from contextlib import closing
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import sqlite3
import struct
import subprocess
import sys
import time
import uuid

FORMAT = 2
BUSINESS_TABLES = (
    'sessions', 'aliases', 'tasks', 'task_receipts', 'task_amendments',
    'bug_buckets', 'bug_reports', 'bug_message_anchors', 'bug_evidence_refs',
    'bug_questions', 'bug_question_replies', 'pending_question_replies',
    'github_issue_links', 'github_issue_operations', 'github_changes', 'github_change_updates',
    'routines', 'routine_occurrences', 'deliveries', 'ingress_routes',
    'todos', 'memory_notes', 'space_rooms', 'space_members', 'circles',
)


class GuardError(Exception):
    pass


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def digest(key, value):
    return hmac.new(key, canonical(value), hashlib.sha256).hexdigest()


def file_hash(path):
    result = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def write_json(path, value):
    path = Path(path)
    with path.open('x', encoding='utf-8') as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def readonly(path, immutable=False):
    path = Path(path).resolve(strict=True)
    connection = sqlite3.connect(path.as_uri() + '?mode=ro' + ('&immutable=1' if immutable else ''), uri=True, timeout=5)
    connection.execute('PRAGMA query_only = ON')
    return connection


def quick_check(connection):
    if connection.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
        raise GuardError('quick_check_failed')


def online_backup(source, target, timeout=30, frozen_source=False):
    """The source is always mode=ro; backup includes committed WAL frames."""
    source, target = Path(source).resolve(strict=True), Path(target).absolute()
    if source == target or target.exists():
        raise GuardError('backup_target_already_exists')
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    start = time.monotonic()
    def progress(_status, _remaining, _total):
        if time.monotonic() - start > timeout:
            raise GuardError('backup_timeout')
    try:
        with closing(readonly(source, immutable=frozen_source)) as src, closing(sqlite3.connect(target)) as dst:
            src.backup(dst, pages=128, progress=progress, sleep=0.01)
            quick_check(dst)
            # Only the completed destination changes journal mode. A standalone, chmod 0400
            # backup must remain readable on SQLite builds that cannot create readonly WAL sidecars.
            if dst.execute('PRAGMA journal_mode = DELETE').fetchone()[0] != 'delete':
                raise GuardError('backup_not_standalone')
        # Some SQLite builds retain an empty destination SHM after switching to DELETE.
        # Both connections are closed and this exclusively created target is not shared.
        for suffix in ['-wal', '-shm', '-journal']:
            Path(str(target) + suffix).unlink(missing_ok=True)
        # No checkpoint or journal mutation is issued against the source.
    except BaseException:
        target.unlink(missing_ok=True)
        raise


def value_token(value):
    # Do not normalize text whitespace or parse JSON: user wording and refusal must stay exact.
    if isinstance(value, bytes):
        return ['blob', base64.b64encode(value).decode('ascii')]
    if value is None:
        return ['null']
    if isinstance(value, int):
        return ['integer', str(value)]
    if isinstance(value, float):
        return ['real', value.hex()]
    return ['text', value]


def table_names(connection):
    return [r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]


def unsupported_tokenizer(error):
    # Do not retry corruption, permissions or arbitrary SQL failures via another engine.
    return isinstance(error, sqlite3.OperationalError) and str(error) == 'no such tokenizer: trigram'


def read_table_via_node(db_path, name):
    """Read every original column/value using the app's SQLite. Output stays in a private pipe."""
    reader = Path(__file__).with_name('sqlite-table-reader.mjs')
    env = {key: os.environ[key] for key in ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SYSTEMROOT'] if key in os.environ}
    try:
        result = subprocess.run([os.environ.get('FRIDAY_MIGRATION_NODE', 'node'), '--no-warnings', str(reader), str(db_path), name],
                                env=env, capture_output=True, timeout=30, check=False)
        if result.returncode:
            raise GuardError('sqlite_compatibility_reader_failed')
        data = json.loads(result.stdout)
        # IEEE-754 bits preserve Python's original float.hex token contract, including -0/inf.
        for row in data['rows']:
            for token in row:
                if token[0] == 'real64':
                    token[:] = ['real', struct.unpack('>d', bytes.fromhex(token[1]))[0].hex()]
        return data
    except (OSError, subprocess.TimeoutExpired, ValueError, KeyError, TypeError):
        raise GuardError('sqlite_compatibility_reader_failed') from None


def read_table(connection, db_path, name):
    try:
        info = connection.execute('PRAGMA table_info(' + quote(name) + ')').fetchall()
        columns = [r[1] for r in info]
        primary = [r[1] for r in sorted(info, key=lambda r: r[5]) if r[5]]
        rows = [[value_token(v) for v in row] for row in connection.execute(
            'SELECT ' + ','.join(quote(c) for c in columns) + ' FROM ' + quote(name))]
        return {'columns': columns, 'primary_key': primary, 'rows': rows}
    except sqlite3.Error as error:
        if not unsupported_tokenizer(error):
            raise
        # The compatibility reader has another connection. The guard's completed
        # DELETE-mode copies stay stable under this transaction's read lock; a
        # live WAL snapshot could advance independently and must first be backed up.
        if connection.execute('PRAGMA journal_mode').fetchone()[0] == 'wal':
            raise GuardError('sqlite_compatibility_requires_completed_copy') from None
        return read_table_via_node(db_path, name)


def schema_digest(connection, key):
    # Includes all schema definitions, including untouched credential tables, but outputs hashes only.
    definitions = connection.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall()
    return digest(key, definitions)


def snapshot(db_path, key, contract=None, extra_tables=()):
    with closing(readonly(db_path)) as connection:
        connection.execute('BEGIN')
        quick_check(connection)
        available = set(table_names(connection))
        # Hash every existing table, including sequence counters, FTS shadows, KV and OAuth data.
        # Values never leave this process; only per-run keyed digests are persisted.
        selected = sorted(contract['tables']) if contract else sorted(available | set(BUSINESS_TABLES) | set(extra_tables))
        tables = {}
        for name in selected:
            if name not in available:
                tables[name] = {'present': False}
                continue
            data = read_table(connection, db_path, name)
            actual_columns = data['columns']
            expected = contract['tables'][name] if contract else None
            columns = expected['columns'] if expected and expected.get('present') else actual_columns
            primary = expected['primary_key'] if expected and expected.get('present') else data['primary_key']
            if not set(columns).issubset(actual_columns):
                tables[name] = {'present': True, 'missing_columns': sorted(set(columns) - set(actual_columns))}
                continue
            rows = []
            positions = [actual_columns.index(column) for column in columns]
            for row in data['rows']:
                values = [row[index] for index in positions]
                identity = [values[columns.index(c)] for c in primary] if primary else values
                rows.append({'identity': digest(key, identity), 'value': digest(key, values)})
            rows.sort(key=lambda r: (r['identity'], r['value']))
            tables[name] = {'present': True, 'columns': columns, 'primary_key': primary, 'row_count': len(rows), 'rows': rows, 'digest': digest(key, rows)}
        # Only fixed semantic counts; never enumerate raw status/error/note strings.
        counts = {}
        for label, name, field, value in [
            ('user_notes', 'bug_reports', 'record_kind', 'user_note'),
            ('paused_routines', 'routines', 'enabled', 0),
            ('unknown_deliveries', 'deliveries', 'status', 'unknown'),
            ('planned_deliveries', 'deliveries', 'status', 'planned'),
        ]:
            if name in available and field in [r[1] for r in connection.execute('PRAGMA table_info(' + quote(name) + ')')]:
                counts[label] = connection.execute('SELECT count(*) FROM ' + quote(name) + ' WHERE ' + quote(field) + '=?', (value,)).fetchone()[0]
        return {'format': FORMAT, 'quick_check': 'ok', 'tables': tables, 'semantic_counts': counts, 'schema_digest': schema_digest(connection, key), 'table_inventory': sorted(available)}


def compare(before, after, strict_schema=False):
    differences = []
    for name, expected in before['tables'].items():
        current = after['tables'].get(name, {'present': False})
        if not expected.get('present'):
            continue  # new tables are allowed on first upgrade
        if current != expected:
            differences.append({'table': name, 'before_count': expected.get('row_count'), 'after_count': current.get('row_count'), 'reason': 'protected_rows_or_columns_changed'})
    if strict_schema and before['schema_digest'] != after['schema_digest']:
        differences.append({'reason': 'schema_changed_on_second_upgrade'})
    return {'equal': not differences, 'differences': differences}


def protect(source, output, frozen_source=False):
    output = Path(output).absolute()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    os.chmod(output, 0o700)
    key = secrets.token_bytes(32)
    key_path = output / 'summary.key'
    with key_path.open('xb') as stream:
        os.chmod(key_path, 0o600)
        stream.write(key)
    baseline = output / 'baseline.db'
    online_backup(source, baseline, frozen_source=frozen_source)
    summary = snapshot(baseline, key)
    write_json(output / 'baseline-summary.json', summary)
    os.chmod(baseline, 0o400)
    report = {'format': FORMAT, 'action': 'online_backup', 'source_open_mode': 'ro', 'captured_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'protection_dir': str(output), 'backup_sha256': file_hash(baseline), 'quick_check': 'ok',
              'protected_counts': {name: item['row_count'] for name, item in summary['tables'].items() if item.get('present')},
              'semantic_counts': summary['semantic_counts'], 'upgrade_executed': False}
    write_json(output / 'backup-receipt.json', report)
    return report


def reprotect(protection_dir, output):
    """Portable re-backup of a known completed artifact, never an active source database."""
    root = Path(protection_dir).resolve(strict=True)
    baseline = root / 'baseline.db'
    receipt = json.loads((root / 'backup-receipt.json').read_text())
    if file_hash(baseline) != receipt['backup_sha256']:
        raise GuardError('protected_backup_changed')
    if any(Path(str(baseline) + suffix).exists() for suffix in ['-wal', '-shm', '-journal']):
        raise GuardError('frozen_backup_has_sidecars')
    result = protect(baseline, output, frozen_source=True)
    result.update(action='reprotect_completed_backup', source_backup_sha256=receipt['backup_sha256'], source_open_mode='ro_immutable_completed_backup_only')
    write_json(Path(output) / 'reprotection-receipt.json', result)
    return result


def run_upgrade(command, candidate, run_dir, timeout):
    if not command:
        raise GuardError('upgrade_command_required')
    env = {key: os.environ[key] for key in ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SYSTEMROOT'] if key in os.environ}
    runtime_home = run_dir / 'runtime-home'
    runtime_home.mkdir(mode=0o700, exist_ok=True)
    env.update(HOME=str(runtime_home), FRIDAY_HOME=str(runtime_home / 'friday'), DSH_HOME=str(runtime_home / 'dsh'))
    try:
        result = subprocess.run([*command, str(candidate)], cwd=run_dir, env=env, capture_output=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        raise GuardError('upgrade_timeout') from None
    # Discard stdout/stderr; SQL errors or application logs could contain private text.
    return {'exit_code': result.returncode, 'stdout_bytes': len(result.stdout), 'stderr_bytes': len(result.stderr)}


def close_candidate_wal(candidate):
    # The adapter has exited. Checkpoint only this disposable copy, never the live source.
    # This also makes subsequent mode=ro inspection portable across SQLite/VFS versions.
    with closing(sqlite3.connect(candidate)) as connection:
        if connection.execute('PRAGMA journal_mode = DELETE').fetchone()[0] != 'delete':
            raise GuardError('candidate_wal_not_closed')


def verify(protection_dir, command, timeout=60):
    root = Path(protection_dir).resolve(strict=True)
    baseline, key_path = root / 'baseline.db', root / 'summary.key'
    receipt = json.loads((root / 'backup-receipt.json').read_text())
    if file_hash(baseline) != receipt['backup_sha256']:
        raise GuardError('protected_backup_changed')
    key = key_path.read_bytes()
    original = json.loads((root / 'baseline-summary.json').read_text())
    if snapshot(baseline, key) != original:
        raise GuardError('protected_summary_changed')
    run_dir = root / ('verification-' + uuid.uuid4().hex)
    run_dir.mkdir(mode=0o700)
    candidate = run_dir / 'candidate.db'
    online_backup(baseline, candidate)
    result = {'format': FORMAT, 'action': 'verify_twice', 'run_dir': str(run_dir), 'baseline_sha256': receipt['backup_sha256'], 'passes': [], 'passed': False}
    try:
        first = run_upgrade(command, candidate, run_dir, timeout)
        result['passes'].append(first)
        if first['exit_code'] != 0:
            raise GuardError('first_upgrade_failed')
        close_candidate_wal(candidate)
        projected = snapshot(candidate, key, contract=original)
        comparison = compare(original, projected)
        result['old_business_rows'] = comparison
        if not comparison['equal']:
            raise GuardError('first_upgrade_changed_protected_rows')
        added_tables = sorted(set(projected['table_inventory']) - set(original['table_inventory']))
        after_first = snapshot(candidate, key, extra_tables=added_tables)
        write_json(run_dir / 'after-first-summary.json', after_first)
        second = run_upgrade(command, candidate, run_dir, timeout)
        result['passes'].append(second)
        if second['exit_code'] != 0:
            raise GuardError('second_upgrade_failed')
        close_candidate_wal(candidate)
        after_second = snapshot(candidate, key, extra_tables=added_tables)
        write_json(run_dir / 'after-second-summary.json', after_second)
        result['second_upgrade_idempotent'] = compare(after_first, after_second, strict_schema=True)
        if not result['second_upgrade_idempotent']['equal']:
            raise GuardError('second_upgrade_not_idempotent')
        result['added_tables'] = added_tables
        result['passed'] = True
    except GuardError as error:
        result['error_code'] = str(error)
    except (sqlite3.Error, OSError, ValueError):
        result['error_code'] = 'candidate_snapshot_failed'
    finally:
        result['protected_backup_unchanged'] = file_hash(baseline) == receipt['backup_sha256']
        if not result['protected_backup_unchanged']:
            result['passed'] = False
            result['error_code'] = 'protected_backup_changed'
        write_json(run_dir / 'verification.json', result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    backup = sub.add_parser('backup')
    backup.add_argument('--source', required=True)
    backup.add_argument('--out-dir', required=True)
    portable = sub.add_parser('reprotect')
    portable.add_argument('--protection-dir', required=True)
    portable.add_argument('--out-dir', required=True)
    summary = sub.add_parser('snapshot')
    summary.add_argument('--db', required=True)
    summary.add_argument('--key-file', required=True)
    summary.add_argument('--out', required=True)
    comparison = sub.add_parser('compare')
    comparison.add_argument('--before', required=True)
    comparison.add_argument('--after', required=True)
    comparison.add_argument('--strict-schema', action='store_true')
    check = sub.add_parser('verify')
    check.add_argument('--protection-dir', required=True)
    check.add_argument('--timeout-seconds', type=int, default=60)
    check.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    try:
        if args.action == 'backup':
            result = protect(args.source, args.out_dir)
        elif args.action == 'reprotect':
            result = reprotect(args.protection_dir, args.out_dir)
        elif args.action == 'snapshot':
            value = snapshot(args.db, Path(args.key_file).read_bytes())
            write_json(args.out, value)
            result = {'action': 'snapshot', 'quick_check': value['quick_check'], 'tables': len(value['tables'])}
        elif args.action == 'compare':
            result = compare(json.loads(Path(args.before).read_text()), json.loads(Path(args.after).read_text()), args.strict_schema)
            result['passed'] = result['equal']
        else:
            if not 1 <= args.timeout_seconds <= 300:
                raise GuardError('invalid_timeout')
            command = args.command[1:] if args.command[:1] == ['--'] else args.command
            result = verify(args.protection_dir, command, args.timeout_seconds)
        print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
        return 1 if result.get('passed') is False else 0
    except Exception as error:
        code = str(error) if isinstance(error, GuardError) else 'guard_io_or_sqlite_error'
        print(json.dumps({'ok': False, 'error_code': code}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
