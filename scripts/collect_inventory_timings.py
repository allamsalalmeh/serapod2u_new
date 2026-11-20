#!/usr/bin/env python3
"""Extract only allowlisted inventory timing metadata, never raw application logs/HAR bodies."""
import argparse
import json
from pathlib import Path

PREFIX = '[inventory-timing] '
STRINGS = {'id', 'operation', 'event', 'at'}
COUNTS = {'elapsedMs', 'span', 'ms', 'rows', 'requests', 'page', 'offset', 'limit', 'status',
          'ok', 'threw', 'aborted', 'auditMode', 'superseded', 'inputRows', 'summaryRows',
          'ready', 'loading', 'authenticated', 'error', 'renderMs', 'beforeTrace',
          'startSinceNavigationMs', 'detailedTiming', 'ttfbMs', 'downloadMs', 'documentMs',
          'shellMountSinceNavigationMs', 'reload', 'domContentLoadedMs', 'request', 'bodyChars', 'statementTimeout'}

def extract(path, trace_id=None):
    events, seen = [], set()
    for line_no, line in enumerate(Path(path).read_text().splitlines(), 1):
        try:
            outer = json.loads(line)
            message = outer.get('message', '')
            start = message.find(PREFIX)
            if start < 0:
                continue
            event, _ = json.JSONDecoder().raw_decode(message[start + len(PREFIX):])
            if trace_id and not event.get('id', '').startswith(trace_id):
                continue
            clean = {k: v for k, v in event.items()
                     if (k in STRINGS and isinstance(v, str)) or
                     (k in COUNTS and (v is None or isinstance(v, (int, float, bool))))}
            if set(STRINGS) - clean.keys():
                continue
            identity = json.dumps(clean, sort_keys=True)
            if identity in seen:
                continue
            seen.add(identity)
            clean['logLine'] = line_no
            events.append(clean)
        except (ValueError, TypeError, AttributeError):
            continue
    return events

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    root = Path(__file__).resolve().parents[1]
    parser.add_argument('--log', default=str(root / 'app/.next/dev/logs/next-development.log'))
    parser.add_argument('--id', help='Optional inv-... ID; also includes its -lN data loads')
    parser.add_argument('--out', required=True, help='Local JSON output file')
    args = parser.parse_args()
    events = extract(args.log, args.id)
    Path(args.out).write_text(json.dumps({'issueStatus': 'OPEN', 'events': events}, indent=2) + '\n')
    ids = sorted({event['id'] for event in events})
    print(f'Saved {len(events)} timing events across {len(ids)} IDs to {args.out}')
    for trace_id in ids:
        trace_events = [e for e in events if e['id'] == trace_id]
        print(trace_id)
        for e in trace_events:
            if e['event'] == 'end' and 'ms' in e:
                print(f"  {e['operation']}: {e['ms']}ms rows={e.get('rows', '-')} status={e.get('status', '-')} ok={e.get('ok', '-')}")
        starts = {e.get('span'): e for e in trace_events if e['event'] == 'start' and 'span' in e}
        ends = {e.get('span') for e in trace_events if e['event'] == 'end'}
        for span, e in starts.items():
            if span not in ends:
                pending = [p.get('ms', 0) for p in trace_events if p.get('span') == span and p['event'] == 'pending']
                print(f"  STILL PENDING {e['operation']}: >= {max(pending, default=0)}ms")

if __name__ == '__main__':
    main()
