# Agent Package Resolution — VS Code administrator guide

Agent Package Resolution is opt-in. Deploy
`~/.jfrog/agents-conf.json` through the organization’s normal device-management
system; the plugin never overwrites an existing file.

## Recommended configuration

Declare only repositories approved for the organization:

```json
{
  "logLevel": "info",
  "packageResolution": {
    "enabled": true,
    "verifyRepos": true,
    "cacheTtlDays": 7,
    "defaultGlobalRepos": {
      "npm": "npm-virtual",
      "pypi": "pypi-virtual"
    },
    "autoSetup": []
  }
}
```

Repository keys are verified against Artifactory before routing. Invalid or
unreachable repositories remain unresolved rather than falling back to public
registries. Workspace files may replace a repository for an already-governed
package type, but cannot expand the governed scope.

`cacheTtlDays: 0` re-checks all cached state on every session, including
eligible zero-touch `jf setup` receipts. Use it temporarily when troubleshooting,
not as a normal operating setting.

## Rollout checklist

1. Configure and test `jf` on a non-production server.
2. Deploy the configuration to a pilot group.
3. Enable `"chat.plugins.enabled": true` and `"chat.useHooks": true` in VS Code.
4. Start a new Copilot chat and verify the resolved repository table.
5. Monitor `~/.jfrog/logs/agent-hooks.log` before expanding rollout.
