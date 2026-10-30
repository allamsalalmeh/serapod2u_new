#!/usr/bin/env python3
"""Local-only behavioral checks for the ACL-aware inventory readiness report."""

import argparse
import csv
import io
import subprocess
import sys

CLASSIFICATIONS = (
    "PRE_MIGRATION_READY",
    "POST_MIGRATION_VERIFIED",
    "PARTIAL_OR_UNEXPECTED_STATE",
    "INSUFFICIENT_EVIDENCE",
)
TOTALS = "public._stock_transfer_totals(jsonb)"


def run_report(args, setup=None):
    command = [
        args.psql, "-X", "-q", "--csv", "-v", "ON_ERROR_STOP=1",
        "-h", args.host, "-p", str(args.port), "-U", args.user, "-d", args.dbname,
    ]
    stdin = None
    if setup is None:
        command += ["-f", args.report]
    else:
        command += ["-f", "-"]
        stdin = "BEGIN;\n%s\n\\i %s\nROLLBACK;\n" % (setup, args.report)

    try:
        result = subprocess.run(
            command, input=stdin, text=True, capture_output=True, timeout=120, check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise AssertionError("readiness psql timed out") from exc
    if result.returncode != 0:
        raise AssertionError("psql failed (%s):\n%s\n%s" % (
            result.returncode, result.stderr, result.stdout,
        ))

    selected = {}
    for row in csv.reader(io.StringIO(result.stdout)):
        if row and row[0] in ("CLASSIFICATION", "permissions.public_execute"):
            if row[0] in selected:
                raise AssertionError("duplicate report row for %s" % row[0])
            selected[row[0]] = row
    if set(selected) != {"CLASSIFICATION", "permissions.public_execute"}:
        raise AssertionError("could not parse readiness CSV:\n%s\n%s" % (
            result.stdout, result.stderr,
        ))
    return selected


def assert_state(args, expected, setup=None):
    rows = run_report(args, setup)
    classification = rows["CLASSIFICATION"][1]
    if classification != expected:
        raise AssertionError("expected %s, got %s; permission row=%s" % (
            expected, classification, rows["permissions.public_execute"],
        ))
    permission = rows["permissions.public_execute"]
    if expected in ("PRE_MIGRATION_READY", "POST_MIGRATION_VERIFIED"):
        if permission[3] != "PASS" or not permission[1].startswith("0 of "):
            raise AssertionError("ready classification has an invalid ACL row: %s" % permission)
    elif expected == "PARTIAL_OR_UNEXPECTED_STATE":
        if permission[3] != "MISMATCH" or "_stock_transfer_totals" not in permission[1]:
            raise AssertionError("ACL drift was not isolated to the permission row: %s" % permission)
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--psql", required=True)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--user", required=True)
    parser.add_argument("--dbname", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--expect", choices=CLASSIFICATIONS)
    args = parser.parse_args()

    if args.expect:
        assert_state(args, args.expect)
        print("PASS readiness classification:", args.expect)
        return

    assert_state(args, "POST_MIGRATION_VERIFIED")
    print("PASS clean migrated catalog is POST_MIGRATION_VERIFIED with zero PUBLIC/anon access")

    for grantee in ("PUBLIC", "anon"):
        setup = "GRANT EXECUTE ON FUNCTION %s TO %s;" % (TOTALS, grantee)
        assert_state(args, "PARTIAL_OR_UNEXPECTED_STATE", setup)
        print("PASS unexpected %s EXECUTE blocks POST_MIGRATION_VERIFIED" % grantee)


if __name__ == "__main__":
    try:
        main()
    except AssertionError as error:
        print("FAIL:", error, file=sys.stderr)
        sys.exit(1)
