#!/usr/bin/env python3
"""Simple test script to verify Jira API integration with real calls.

Usage:
    export JIRA_BASE_URL=https://your-domain.atlassian.net
    export JIRA_API_TOKEN=your_api_token
    export JIRA_USER_EMAIL=your@email.com
    export JIRA_TYPE=cloud

    python scripts/test_jira_real.py
"""

import os
import sys

# Load environment variables from .env file
from dotenv import load_dotenv

load_dotenv()

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent.tools.jira_get_issue import jira_get_issue
from agent.tools.jira_search_issues import jira_search_issues


def check_config():
    """Check if Jira is configured."""
    required = ["JIRA_BASE_URL", "JIRA_API_TOKEN"]
    missing = [var for var in required if not os.environ.get(var)]

    jira_type = os.environ.get("JIRA_TYPE", "cloud")
    if jira_type == "cloud" and not os.environ.get("JIRA_USER_EMAIL"):
        missing.append("JIRA_USER_EMAIL (required for Jira Cloud)")

    if missing:
        print("❌ Missing environment variables:")
        for var in missing:
            print(f"   - {var}")
        print("\nPlease set these variables and try again.")
        sys.exit(1)

    print("✓ Jira configuration found:")
    print(f"   Base URL: {os.environ.get('JIRA_BASE_URL')}")
    print(f"   Type: {jira_type}")
    print(f"   Email: {os.environ.get('JIRA_USER_EMAIL', 'N/A')}")
    print()


def test_search():
    """Test searching for issues."""
    print("🔍 Testing jira_search_issues...")
    print("   JQL: created >= -30d ORDER BY created DESC")
    print()

    result = jira_search_issues("created >= -30d ORDER BY created DESC", max_results=5)

    if "error" in result:
        print(f"❌ Search failed: {result['error']}")
        return None

    issues = result.get("issues", [])
    total = result.get("total", 0)

    print(f"✓ Search successful! Found {total} total issues")
    print(f"   Returned {len(issues)} issues:")
    for issue in issues:
        key = issue.get("key", "N/A")
        summary = issue.get("fields", {}).get("summary", "No summary")
        status = issue.get("fields", {}).get("status", {}).get("name", "Unknown")
        print(f"   - {key}: {summary} [{status}]")
    print()

    return issues[0]["key"] if issues else None


def test_get_issue(issue_key):
    """Test getting a specific issue."""
    if not issue_key:
        print("⚠️  No issue key available to test jira_get_issue")
        return False

    print(f"📋 Testing jira_get_issue for: {issue_key}")
    print()

    result = jira_get_issue(issue_key)

    if "error" in result:
        print(f"❌ Get issue failed: {result['error']}")
        return False

    issue = result.get("issue", {})
    fields = issue.get("fields", {})

    print("✓ Get issue successful!")
    print(f"   Key: {issue.get('key', 'N/A')}")
    print(f"   ID: {issue.get('id', 'N/A')}")
    print(f"   Summary: {fields.get('summary', 'N/A')}")
    print(f"   Status: {fields.get('status', {}).get('name', 'N/A')}")
    print(f"   Issue Type: {fields.get('issuetype', {}).get('name', 'N/A')}")

    assignee = fields.get("assignee")
    if assignee:
        if "displayName" in assignee:
            print(f"   Assignee: {assignee.get('displayName', 'N/A')}")
        elif "name" in assignee:
            print(f"   Assignee: {assignee.get('name', 'N/A')}")
    else:
        print("   Assignee: Unassigned")

    priority = fields.get("priority")
    if priority:
        print(f"   Priority: {priority.get('name', 'N/A')}")

    print(f"   Created: {fields.get('created', 'N/A')}")
    print(f"   Updated: {fields.get('updated', 'N/A')}")
    print()
    return True


def main():
    """Run the Jira API tests."""
    print("=" * 60)
    print("Jira API Integration Test")
    print("=" * 60)
    print()

    check_config()

    # Test search first to get an issue key
    issue_key = test_search()

    # Then test get_issue with a real key
    success = test_get_issue(issue_key)

    print("=" * 60)
    if success:
        print("✓ All tests passed! Jira integration is working.")
    else:
        print("⚠️  Some tests had issues, but basic connectivity may work.")
    print("=" * 60)


if __name__ == "__main__":
    main()
