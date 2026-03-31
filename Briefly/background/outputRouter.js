/**
 * Briefly — outputRouter.js (background)
 * Routes output to integrations: Notion, GitHub, Jira, Linear, Slack, Confluence, Webhook.
 */

/* global chrome */

import {
  buildNotionBlocks,
  parseGitHubThread,
  buildAtlassianDoc,
  escapeHtml,
  resolveGitHubRouteMode,
  resolveJiraRouteMode
} from './routerUtils.mjs';

const OutputRouter = {
  async route(target, output, context, tabId, options = {}) {
    // Get integration configs
    const { encryptedKeys = {} } = await chrome.storage.local.get('encryptedKeys');
    const { settings = {} } = await chrome.storage.local.get('settings');

    const handler = () => {
      switch (target) {
        case 'page':     return this.applyToPage(output, tabId, options);
        case 'notion':   return this.sendToNotion(output, context, encryptedKeys);
        case 'github':   return this.sendToGitHub(output, context, encryptedKeys, settings, options);
        case 'jira':     return this.sendToJira(output, context, encryptedKeys, settings, options);
        case 'linear':   return this.sendToLinear(output, context, encryptedKeys);
        case 'slack':    return this.sendToSlack(output, context, encryptedKeys);
        case 'confluence': return this.sendToConfluence(output, context, encryptedKeys, settings);
        case 'webhook':  return this.sendToWebhook(output, context, settings, encryptedKeys);
        default: throw new Error(`Unknown integration: ${target}`);
      }
    };

    // Retry with exponential backoff for transient failures
    return this._withRetry(handler, { maxRetries: 3, target });
  },

  async _withRetry(fn, { maxRetries = 3, target = '' } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const status = this._extractHttpStatus(err);
        // Only retry on transient errors (429, 5xx, network)
        const isTransient = !status || status === 429 || status >= 500;
        if (!isTransient || attempt === maxRetries) break;
        const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 10000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw this._enrichError(lastError, target);
  },

  _extractHttpStatus(err) {
    const match = String(err?.message || '').match(/(\d{3})/);
    return match ? parseInt(match[1], 10) : null;
  },

  _enrichError(err, target) {
    const message = err?.message || 'Unknown error';
    const status = this._extractHttpStatus(err);
    const diagnostics = [];

    if (status === 401 || status === 403) {
      diagnostics.push(`Authentication failed for ${target}. Check your API key or token in Settings.`);
    } else if (status === 404) {
      diagnostics.push(`Resource not found. Verify your ${target} configuration (page ID, repo, project key).`);
    } else if (status === 429) {
      diagnostics.push(`Rate limited by ${target}. Wait a moment and try again.`);
    } else if (status >= 500) {
      diagnostics.push(`${target} service error (${status}). The service may be temporarily unavailable.`);
    } else if (!status) {
      diagnostics.push(`Network error reaching ${target}. Check your internet connection.`);
    }

    const enrichedMessage = diagnostics.length
      ? `${message}\n\nDiagnostic: ${diagnostics.join(' ')}`
      : message;

    const enrichedError = new Error(enrichedMessage);
    enrichedError.originalError = err;
    enrichedError.target = target;
    enrichedError.httpStatus = status;
    return enrichedError;
  },

  async sendToNotion(output, context, encryptedKeys) {
    const token = await this._decrypt(encryptedKeys.notion);
    if (!token) throw new Error('Notion token not configured. Please add it in Settings.');
    const { integrations = {} } = await chrome.storage.local.get('integrations');
    const pageId = integrations.notion?.defaultPageId;
    if (!pageId) throw new Error('No Notion target page set. Configure in Settings → Integrations.');
    const res = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        children: buildNotionBlocks(output, context)
      })
    });
    if (!res.ok) throw new Error(`Notion API error: ${res.status}`);
    return { success: true, message: 'Appended to Notion page' };
  },

  async sendToGitHub(output, context, encryptedKeys, settings, options = {}) {
    const token = await this._decrypt(encryptedKeys.github);
    if (!token) throw new Error('GitHub token not configured.');
    const route = resolveGitHubRouteMode(context, options);
    const currentThread = route.thread;
    const { integrations = {} } = await chrome.storage.local.get('integrations');
    const repo = currentThread?.repo || integrations.github?.defaultRepo;
    if (!repo) throw new Error('No GitHub repo configured. Set default repo in Settings → Integrations.');

    if (route.mode === 'comment') {
      if (!currentThread) throw new Error('No GitHub issue or pull request detected on the current page.');
      const commentRes = await fetch(`https://api.github.com/repos/${repo}/issues/${currentThread.number}/comments`, {
        method: 'POST',
        headers: {
          'Authorization': `token ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github.v3+json'
        },
        body: JSON.stringify({
          body: `${output}\n\n---\n*Posted by Briefly from ${context.url || 'the active page'}*`
        })
      });
      if (!commentRes.ok) throw new Error(`GitHub API error: ${commentRes.status}`);
      const data = await commentRes.json();
      return {
        success: true,
        message: `Commented on GitHub ${currentThread.kind} #${currentThread.number}`,
        url: data.html_url
      };
    }

    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json'
      },
      body: JSON.stringify({
        title: context.pageTitle ? `Briefly: ${context.pageTitle.slice(0, 80)}` : 'Briefly Issue',
        body: `${output}\n\n---\n*Created by Briefly from: ${context.url}*`,
        labels: ['briefly']
      })
    });
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    const data = await res.json();
    return { success: true, message: `Created GitHub issue #${data.number}`, url: data.html_url };
  },

  async sendToJira(output, context, encryptedKeys, settings, options = {}) {
    const token = await this._decrypt(encryptedKeys.jira);
    if (!token) throw new Error('Jira token not configured.');
    const { integrations = {} } = await chrome.storage.local.get('integrations');
    const { jiraDomain, jiraEmail, jiraProject } = integrations.jira || {};
    if (!jiraDomain || !jiraEmail) {
      throw new Error('Jira not fully configured. Add domain and email in Settings.');
    }
    const authB64 = btoa(`${jiraEmail}:${token}`);
    const route = resolveJiraRouteMode(context, options);
    const issueKey = route.issueKey;

    if (route.mode === 'comment') {
      if (!issueKey) throw new Error('No Jira ticket detected on the current page.');
      const commentRes = await fetch(`https://${jiraDomain}/rest/api/3/issue/${issueKey}/comment`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${authB64}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          body: buildAtlassianDoc(output)
        })
      });
      if (!commentRes.ok) throw new Error(`Jira API error: ${commentRes.status}`);
      return { success: true, message: `Added comment to Jira issue ${issueKey}` };
    }

    if (!jiraProject) {
      throw new Error('No Jira project configured. Add a project key in Settings.');
    }

    const res = await fetch(`https://${jiraDomain}/rest/api/3/issue`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authB64}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        fields: {
          project: { key: jiraProject },
          summary: context.pageTitle ? `Briefly: ${context.pageTitle.slice(0, 80)}` : 'Briefly Issue',
          description: buildAtlassianDoc(output),
          issuetype: { name: 'Task' }
        }
      })
    });
    if (!res.ok) throw new Error(`Jira API error: ${res.status}`);
    const data = await res.json();
    return { success: true, message: `Created Jira issue ${data.key}` };
  },

  async sendToLinear(output, context, encryptedKeys) {
    const token = await this._decrypt(encryptedKeys.linear);
    if (!token) throw new Error('Linear token not configured.');
    const { integrations = {} } = await chrome.storage.local.get('integrations');
    const teamId = integrations.linear?.teamId;
    if (!teamId) throw new Error('Linear team ID not configured.');
    const query = `mutation CreateIssue($title: String!, $description: String!, $teamId: String!) {
      issueCreate(input: { title: $title, description: $description, teamId: $teamId }) {
        success issue { identifier url }
      }
    }`;
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Authorization': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: {
          title: context.pageTitle ? `Briefly: ${context.pageTitle.slice(0, 80)}` : 'Briefly Issue',
          description: output.slice(0, 5000),
          teamId
        }
      })
    });
    if (!res.ok) throw new Error(`Linear API error: ${res.status}`);
    const data = await res.json();
    const issue = data.data?.issueCreate?.issue;
    return { success: true, message: `Created Linear issue ${issue?.identifier}`, url: issue?.url };
  },

  async sendToSlack(output, context, encryptedKeys) {
    const webhookUrl = await this._decrypt(encryptedKeys.slack);
    if (!webhookUrl) throw new Error('Slack webhook URL not configured.');
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `*Briefly Output* — <${context.url}|${context.pageTitle || 'View Page'}>`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*Briefly Output*\n\n${output.slice(0, 3000)}` } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: `From: <${context.url}|${context.pageTitle || context.url}>` }] }
        ]
      })
    });
    if (!res.ok) throw new Error(`Slack API error: ${res.status}`);
    return { success: true, message: 'Posted to Slack' };
  },

  async sendToConfluence(output, context, encryptedKeys, settings) {
    const token = await this._decrypt(encryptedKeys.confluence || encryptedKeys.jira);
    if (!token) throw new Error('Confluence token not configured.');
    const { integrations = {} } = await chrome.storage.local.get('integrations');
    const { confluenceDomain, confluenceEmail, confluenceSpaceKey, confluencePageId } = integrations.confluence || {};
    if (!confluenceDomain) throw new Error('Confluence domain not configured.');
    const authB64 = btoa(`${confluenceEmail}:${token}`);
    // Get current page version first
    const pageRes = await fetch(`https://${confluenceDomain}/wiki/rest/api/content/${confluencePageId}?expand=version`, {
      headers: { 'Authorization': `Basic ${authB64}`, 'Accept': 'application/json' }
    });
    if (!pageRes.ok) throw new Error(`Confluence API error: ${pageRes.status}`);
    const pageData = await pageRes.json();
    const newVersion = (pageData.version?.number || 0) + 1;
    const updateRes = await fetch(`https://${confluenceDomain}/wiki/rest/api/content/${confluencePageId}`, {
      method: 'PUT',
      headers: { 'Authorization': `Basic ${authB64}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: { number: newVersion },
        title: pageData.title,
        type: 'page',
        body: {
          storage: {
            value: `${pageData.body?.storage?.value || ''}<h3>Briefly Output</h3><p>${escapeHtml(output).slice(0, 3000).replace(/\n/g, '<br />')}</p>`,
            representation: 'storage'
          }
        }
      })
    });
    if (!updateRes.ok) throw new Error(`Confluence update error: ${updateRes.status}`);
    return { success: true, message: 'Appended to Confluence page' };
  },

  async sendToWebhook(output, context, settings, encryptedKeys) {
    const webhookUrl = settings.webhookUrl || await this._decrypt(encryptedKeys.webhook);
    if (!webhookUrl) throw new Error('Custom webhook URL not configured in Settings.');
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        output,
        context: {
          pageTitle: context.pageTitle,
          url: context.url,
          intent: context.intent,
          pageType: context.pageType,
          domainArtifacts: context.domainArtifacts,
          timestamp: Date.now()
        },
        source: 'briefly'
      })
    });
    if (!res.ok) throw new Error(`Webhook error: ${res.status}`);
    return { success: true, message: 'Sent to webhook' };
  },

  async applyToPage(output, tabId, options = {}) {
    if (!tabId) throw new Error('No active tab available for page insertion.');
    const actionId = options.actionTargetId;
    if (!actionId) throw new Error('No editable page target detected.');

    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'APPLY_OUTPUT_TO_PAGE',
      actionId,
      text: output,
      mode: options.mode || 'auto',
      submitActionId: options.submitActionId || ''
    });

    if (!response?.success) {
      throw new Error(response?.error || 'Failed to apply output to the page.');
    }

    return {
      success: true,
      message: response.result?.triggeredActionLabel
        ? `Inserted into ${response.result?.label || 'the active page field'} and triggered ${response.result.triggeredActionLabel}`
        : `Inserted into ${response.result?.label || 'the active page field'}`,
      appliedMode: response.result?.appliedMode || 'replace'
    };
  },

  async _decrypt(encrypted) {
    if (!encrypted) return '';
    try {
      const { cryptoKeyRaw } = await chrome.storage.local.get('cryptoKeyRaw');
      if (!cryptoKeyRaw) return '';
      const key = await crypto.subtle.importKey('raw', new Uint8Array(cryptoKeyRaw), { name: 'AES-GCM' }, false, ['decrypt']);
      const combined = new Uint8Array(atob(encrypted).split('').map(c => c.charCodeAt(0)));
      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      return new TextDecoder().decode(decrypted);
    } catch { return ''; }
  }
};

if (typeof self !== 'undefined') self.OutputRouter = OutputRouter;
