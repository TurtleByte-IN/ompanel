import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput, GitRunStackedActionInput } from "./git.ts";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  // OMP's own config files belong to the provider install, like its other provider settings.
  [WS_METHODS.serverWriteOmpSetting]: AuthProvidersManageScope,
  [WS_METHODS.serverResetOmpSetting]: AuthProvidersManageScope,
  // A thread override changes what one running thread does, like other thread operations.
  [WS_METHODS.serverSetOmpThreadOverride]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverClearOmpThreadOverride]: AuthOrchestrationOperateScope,
  // Sharing sends the thread outside T3: a gist on GitHub, or a live link through OMP's relay that
  // bypasses pairing. A room's status carries its links, so reading it needs operate too.
  [WS_METHODS.serverShareOmpThreadGist]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverStartOmpThreadCollab]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverStopOmpThreadCollab]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverGetOmpThreadCollab]: AuthOrchestrationOperateScope,
  // Signing in and out of OMP's providers changes the provider install's stored credentials.
  [WS_METHODS.serverStartOmpSignIn]: AuthProvidersManageScope,
  [WS_METHODS.serverAnswerOmpSignIn]: AuthProvidersManageScope,
  [WS_METHODS.serverCancelOmpSignIn]: AuthProvidersManageScope,
  [WS_METHODS.serverOmpSignOut]: AuthProvidersManageScope,
  // Custom agents, the advisor roster, custom providers, MCP servers, skills, rules, prompts,
  // hooks and custom tools are files of the provider install's agent directory.
  [WS_METHODS.serverWriteOmpAgentFile]: AuthProvidersManageScope,
  [WS_METHODS.serverDeleteOmpAgentFile]: AuthProvidersManageScope,
  [WS_METHODS.serverUnpackOmpAgents]: AuthProvidersManageScope,
  // Plugins are third-party code run by the provider install; reloading reaches its threads.
  [WS_METHODS.serverRunOmpPluginCommand]: AuthProvidersManageScope,
  [WS_METHODS.serverReloadOmpPlugins]: AuthProvidersManageScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.controlSubagent]: AuthOrchestrationOperateScope,
  // A guest link hands thread access to someone outside, like a pairing link.
  [WS_METHODS.guestShareCreate]: AuthAccessWriteScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeStackedAction = Schema.decodeUnknownSync(GitRunStackedActionInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitRunStackedAction && input !== undefined) {
    const payload = decodeStackedAction(input);
    if (
      payload.threadId !== undefined &&
      (payload.action === "create_pr" || payload.action === "commit_push_pr")
    )
      return [AuthSourceControlWriteScope, AuthOrchestrationReadScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
