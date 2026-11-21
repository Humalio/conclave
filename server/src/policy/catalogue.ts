/** Permission catalogue (SPECIFICATION §8). */

/** Tools every logged-in session may use; they only reveal the session's own state. */
export const BASE_TOOLS = ['session_logout', 'session_whoami', 'session_describe', 'session_ack', 'access_list', 'access_check', 'access_request', 'access_status', 'team_info', 'work_next', 'work_ack'] as const;

/**
 * Default tools: allowed for every logged-in session without a `tool.invoke` grant, but an explicit deny rule on the
 * session key or the app key (for example `tool:feedback_*`) refuses them. Base tools cannot be denied.
 */
export const DEFAULT_TOOLS = ['feedback_find', 'feedback_file', 'feedback_read', 'feedback_add', 'directives_list', 'directives_read', 'directives_report',
  // Hardware (docs/hardware.md): the machine's team list is the authority, so no grant is needed; a deny on tool:hw_* refuses them.
  'hw_list', 'hw_join', 'hw_report', 'hw_leave',
  // Without the channel grants it answers only for the caller's own task-file uploads (docs/transfers.md); any other channel needs
  // tool:channel_status and channel.use, as before.
  'channel_status'] as const;

/** Tools that need an explicit `tool.invoke` grant on `tool:<name>`. */
export const GRANTED_TOOLS = ['file_list', 'file_read', 'file_search', 'file_stat',
  'file_create', 'file_update', 'file_patch', 'file_rename', 'file_delete', 'file_history', 'file_diff', 'file_restore', 'file_conflicts',
  'agent_list', 'message_send', 'message_read', 'message_ack', 'message_history', 'room_list', 'room_create', 'room_join', 'room_leave', 'room_invite',
  'share_create', 'share_upload', 'share_list', 'share_info', 'share_read', 'share_diff', 'share_comment', 'share_suggest', 'share_feedback', 'share_resolve', 'share_download', 'share_promote', 'share_close',
  'graph_related', 'graph_impact', 'graph_query', 'graph_context', 'graph_summary', 'graph_job_submit', 'graph_upsert', 'graph_summary_write',
  'channel_open', 'channel_list', 'channel_accept', 'channel_send', 'channel_receive', 'channel_close', 'file_download'] as const;

export const ALL_ACTIONS = [
  'tool.invoke',
  'fs.list', 'fs.read', 'fs.search', 'fs.create', 'fs.update', 'fs.rename', 'fs.delete', 'fs.download', 'fs.history', 'fs.restore', 'fs.conflicts',
  'message.send', 'message.receive', 'channel.open', 'channel.accept', 'share.with',
  'room.join', 'room.post', 'room.read_history', 'room.invite', 'room.create',
  'team.member', 'task.create', 'task.assign', 'task.claim', 'task.review', 'task.complete', 'task.block', 'team.report', 'team.complete', 'team.recruit', 'team.ask',
  'share.create', 'share.upload', 'share.read', 'share.comment', 'share.suggest', 'share.promote',
  'channel.use',
  'graph.read', 'graph.write', 'graph.review',
] as const;

export interface TemplateDef { name: string; description: string; rules: { effect: 'allow' | 'deny'; actions: string[]; resource: string }[] }

/** Built-in templates. Applying one copies its rules into the key (no inheritance). */
export function builtinTemplates(vaultAlias: string): TemplateDef[] {
  const v = `/${vaultAlias}/**`;
  return [
    {
      name: 'Reader',
      description: 'List, read and search the whole vault',
      rules: [
        { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' },
        { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:graph_context' },
        { effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.search'], resource: `path:${v}` },
      ],
    },
    {
      name: 'Writer',
      description: 'Reader plus create, update and history in the vault',
      rules: [
        { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' },
        { effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.search', 'fs.create', 'fs.update', 'fs.history'], resource: `path:${v}` },
      ],
    },
    {
      name: 'Reviewer',
      description: 'Read the vault; review tasks',
      rules: [
        { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' },
        { effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.search', 'fs.history'], resource: `path:${v}` },
        { effect: 'allow', actions: ['task.review'], resource: 'team:*' },
      ],
    },
    {
      name: 'Coordinator',
      description: 'Read the vault; create and assign tasks',
      rules: [
        { effect: 'allow', actions: ['tool.invoke'], resource: 'tool:file_*' },
        { effect: 'allow', actions: ['fs.list', 'fs.read', 'fs.search'], resource: `path:${v}` },
        { effect: 'allow', actions: ['task.create', 'task.assign', 'task.complete', 'task.block', 'team.report', 'team.complete'], resource: 'team:*' },
      ],
    },
  ];
}
