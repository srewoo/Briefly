/**
 * Productify — outputRouter.js (background)
 * Routes output to integrations: Notion, GitHub, Jira, Linear, Slack, Confluence, Webhook.
 */

/* global chrome */

const OutputRouter = {
  async route(target, output, context, tabId) {
    // Get integration configs
    const { encryptedKeys = {} } = await chrome.storage.local.get('encryptedKeys');
    const { settings = {} } = await chrome.storage.local.get('settings');

    switch (target) {
      case 'notion':   return this.sendToNotion(output, context, encryptedKeys);
      case 'github':   return this.sendToGitHub(output, context, encryptedKeys, settings);
      case 'jira':     return this.sendToJira(output, context, encryptedKeys, settings);
      case 'linear':   return this.sendToLinear(output, context, encryptedKeys);
      case 'slack':    return this.sendToSlack(output, context, encryptedKeys);
      case 'confluence': return this.sendToConfluence(output, context, encryptedKeys, settings);
      case 'webhook':  return this.sendToWebhook(output, context, settings, encryptedKeys);
      default: throw new Error(`Unknown integration: ${target}`);
    }
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
        children: [
          { object: 'block', type: 'heading_2', heading_2: { rich_text: [{ type: 'text', text: { content: context.intent ? `Productify: ${context.intent}` : 'Productify Output' } }] } },
          { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: output.slice(0, 2000) } }] } }
        ]
      })
    });
    if (!res.ok) throw new Error(`Notion API error: ${res.status}`);
    return { success: true, message: 'Appended to Notion page' };
  },

  async sendToGitHub(output, context, encryptedKeys, settings) {
    const token = await this._decrypt(encryptedKeys.github);
    if (!token) throw new Error('GitHub token not configured.');
    const { integrations = {} } = await chrome.storage.local.get('integrations');
    const repo = integrations.github?.defaultRepo;
    if (!repo) throw new Error('No GitHub repo configured. Set default repo in Settings → Integrations.');
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json'
      },
      body: JSON.stringify({
        title: context.pageTitle ? `Productify: ${context.pageTitle.slice(0, 80)}` : 'Productify Issue',
        body: `${output}\n\n---\n*Created by Productify from: ${context.url}*`,
        labels: ['productify']
      })
    });
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    const data = await res.json();
    return { success: true, message: `Created GitHub issue #${data.number}`, url: data.html_url };
  },

  async sendToJira(output, context, encryptedKeys, settings) {
    const token = await this._decrypt(encryptedKeys.jira);
    if (!token) throw new Error('Jira token not configured.');
    const { integrations = {} } = await chrome.storage.local.get('integrations');
    const { jiraDomain, jiraEmail, jiraProject } = integrations.jira || {};
    if (!jiraDomain || !jiraEmail || !jiraProject) {
      throw new Error('Jira not fully configured. Add domain, email, and project key in Settings.');
    }
    const authB64 = btoa(`${jiraEmail}:${token}`);
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
          summary: context.pageTitle ? `Productify: ${context.pageTitle.slice(0, 80)}` : 'Productify Issue',
          description: { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: output.slice(0, 5000) }] }] },
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
          title: context.pageTitle ? `Productify: ${context.pageTitle.slice(0, 80)}` : 'Productify Issue',
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
        text: `*Productify Output* — <${context.url}|${context.pageTitle || 'View Page'}>`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*Productify Output*\n\n${output.slice(0, 3000)}` } },
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
            value: `${pageData.body?.storage?.value || ''}<h3>Productify Output</h3><p>${output.slice(0, 3000)}</p>`,
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
          timestamp: Date.now()
        },
        source: 'productify'
      })
    });
    if (!res.ok) throw new Error(`Webhook error: ${res.status}`);
    return { success: true, message: 'Sent to webhook' };
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
