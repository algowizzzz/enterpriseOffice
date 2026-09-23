/**
 * Executes a workflow group against a document: every analysis-role prompt
 * runs against the document's text, in parallel (nothing here has any
 * prompt read another's output), then the group's one summary prompt runs
 * once more over what they produced (docs/16-ai-integration.md §5). Both the
 * individual outputs and the summary are returned; this codebase's own rule
 * against hiding what happened to a person's content (`CLAUDE.md`, "never
 * remove somebody's content silently") applies just as much to a model's
 * intermediate output as to an edit.
 */
import type { Database } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { getDefaultEndpointId, runCompletion } from './llmEndpoints.js';
import { getWorkflowGroup } from './workflowGroups.js';
import type { DocumentType } from './documents.js';

export interface AnalysisPromptResult {
  promptId: string;
  text: string;
  output: string;
}

export interface AnalysisRunResult {
  ok: boolean;
  message: string;
  groupId: string;
  groupName: string;
  endpointId?: string;
  /** Present even on a failed summary, so nothing already produced is hidden. */
  analysis?: AnalysisPromptResult[];
  summary?: string;
}

/**
 * Refuses a group that does not apply to this document's type. The client's
 * own dropdown is already filtered (docs/16 §11), but the choice is still
 * something an authenticated request states rather than something the
 * server derives, so it is checked again here.
 */
export function assertGroupAppliesToDocType(
  groupDocType: DocumentType | null,
  documentDocType: DocumentType | null,
): void {
  if (groupDocType !== null && groupDocType !== documentDocType) {
    throw badRequest('That workflow group does not apply to this kind of document.');
  }
}

export async function runWorkflowGroup(
  db: Database,
  secretKey: Buffer,
  groupId: string,
  documentText: string,
  documentDocType: DocumentType | null,
): Promise<AnalysisRunResult> {
  const group = getWorkflowGroup(db, groupId);
  assertGroupAppliesToDocType(group.docType, documentDocType);

  const endpointId = group.endpointId ?? getDefaultEndpointId(db);
  const failure = (message: string): AnalysisRunResult => ({
    ok: false,
    message,
    groupId: group.id,
    groupName: group.name,
  });
  if (!endpointId) {
    return failure(
      'No AI endpoint is configured for this workflow group or as the installation default.',
    );
  }

  const analysisPrompts = group.prompts
    .filter((prompt) => prompt.role === 'analysis')
    .sort((a, b) => a.position - b.position);
  const summaryPrompt = group.prompts.find((prompt) => prompt.role === 'summary');
  if (!summaryPrompt) {
    // Every group is created with exactly one; this guards against a bug
    // rather than a state an admin can reach through the API.
    throw notFound('This workflow group has no summary prompt');
  }

  const outcomes = await Promise.all(
    analysisPrompts.map(async (prompt) => {
      const result = await runCompletion(
        db,
        secretKey,
        endpointId,
        [
          { role: 'system', content: `You are analysing the document below.\n\n${documentText}` },
          { role: 'user', content: prompt.text },
        ],
        { maxTokens: 1024 },
      );
      return { prompt, result };
    }),
  );

  const failed = outcomes.find(({ result }) => !result.ok || result.content === undefined);
  if (failed) {
    return failure(`"${failed.prompt.text}" failed: ${failed.result.message}`);
  }

  const analysis: AnalysisPromptResult[] = outcomes.map(({ prompt, result }) => ({
    promptId: prompt.id,
    text: prompt.text,
    output: result.content as string,
  }));

  const summaryInput = analysis.map((entry) => `${entry.text}\n${entry.output}`).join('\n\n');
  const summaryResult = await runCompletion(
    db,
    secretKey,
    endpointId,
    [
      { role: 'system', content: 'Summarise the analysis findings below.' },
      { role: 'user', content: `${summaryPrompt.text}\n\n${summaryInput}` },
    ],
    { maxTokens: 1024 },
  );
  if (!summaryResult.ok || summaryResult.content === undefined) {
    // The analysis prompts already succeeded: hand their output back rather
    // than throwing it away because the summary step failed.
    return {
      ok: false,
      message: `The summary failed: ${summaryResult.message}`,
      groupId: group.id,
      groupName: group.name,
      endpointId,
      analysis,
    };
  }

  return {
    ok: true,
    message: 'Complete.',
    groupId: group.id,
    groupName: group.name,
    endpointId,
    analysis,
    summary: summaryResult.content,
  };
}
