export function buildNotionBlocks(output, context = {}) {
  const heading = context.intent ? `Briefly: ${context.intent}` : 'Briefly Output';
  const paragraphs = String(output || '')
    .split(/\n{2,}/)
    .map(chunk => chunk.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map(chunk => ({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{
          type: 'text',
          text: { content: chunk.slice(0, 1900) }
        }]
      }
    }));

  return [
    {
      object: 'block',
      type: 'heading_2',
      heading_2: { rich_text: [{ type: 'text', text: { content: heading } }] }
    },
    ...paragraphs
  ];
}

export function parseGitHubThread(context = {}) {
  const url = context.url || '';
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/);
  if (!match) return null;
  return {
    repo: `${match[1]}/${match[2]}`,
    kind: match[3] === 'pull' ? 'pull request' : 'issue',
    number: Number(match[4])
  };
}

export function buildAtlassianDoc(text) {
  const paragraphs = String(text || '')
    .split(/\n{2,}/)
    .map(chunk => chunk.trim())
    .filter(Boolean)
    .slice(0, 20)
    .map(chunk => ({
      type: 'paragraph',
      content: [{
        type: 'text',
        text: chunk.slice(0, 5000)
      }]
    }));

  return {
    version: 1,
    type: 'doc',
    content: paragraphs.length ? paragraphs : [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }]
  };
}

export function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function resolveGitHubRouteMode(context = {}, options = {}) {
  const thread = parseGitHubThread(context);
  if (options.mode === 'create') {
    return { mode: 'create', thread: null };
  }
  if (options.mode === 'comment') {
    return { mode: 'comment', thread };
  }
  return thread ? { mode: 'comment', thread } : { mode: 'create', thread: null };
}

export function resolveJiraRouteMode(context = {}, options = {}) {
  const issueKey = context?.pageType === 'jira-ticket' ? context?.domainArtifacts?.issueKey : '';
  if (options.mode === 'create') {
    return { mode: 'create', issueKey: '' };
  }
  if (options.mode === 'comment') {
    return { mode: 'comment', issueKey };
  }
  return issueKey ? { mode: 'comment', issueKey } : { mode: 'create', issueKey: '' };
}
