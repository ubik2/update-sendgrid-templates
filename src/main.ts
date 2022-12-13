import * as core from "@actions/core";
import * as path from "path";
import fs from "fs";
import { Client } from "@sendgrid/client";
import { ClientRequest } from "@sendgrid/client/src/request";

interface TemplateInfoEntry {
  env_template_id: { [environment: string]: string };
  name: string;
  subject: string;
  html: string;
  test_data?: { [key: string]: any };
}

interface TemplateInfo {
  template_id: string;
  name: string;
  subject: string;
  html: string;
  test_data?: { [key: string]: any };
}

interface BaseTemplateVersion {
  template_id: string;
  name: string;
  subject: string;
  html_content: string;
}

interface TemplateVersion extends BaseTemplateVersion {
  id: string;
  active: number;
  updated_at: string;
  generate_plain_content: boolean;
  editor: string;
  thumbnail_url: string;
}

interface SendGridTemplatesResponse {
  id: string;
  name: string;
  generation: string;
  updated_at: string;
  versions: [TemplateVersion];
}

function getAbsoluteTemplateInfoPath(rootDir: string, templateInfoPath: string): string {
  const templateInfoPlatformPath = core.toPlatformPath(templateInfoPath);
  return path.join(rootDir, templateInfoPlatformPath);
}

function getTemplateInfo(absolutePath: string): [TemplateInfoEntry] {
  const templateInfo = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  return templateInfo.map((item: any) => item as TemplateInfoEntry);
}

async function getExistingTemplates(client: Client, template_id: string): Promise<[TemplateVersion]> {
  const request: ClientRequest = {
    url: `/v3/templates/${template_id}`,
    method: "GET",
  };

  const responseInfo = await client.request(request);
  if (responseInfo[0].statusCode == 200) {
    const responseObj = responseInfo[0].body as SendGridTemplatesResponse;
    return responseObj.versions;
  } else {
    console.log(responseInfo[0]);
    throw "Invalid status code";
  }
}

async function activateExistingTemplate(client: Client, templateVersion: TemplateVersion) {
  const request: ClientRequest = {
    url: `/v3/templates/${templateVersion.template_id}/versions/${templateVersion.id}/activate`,
    method: "POST",
  };

  const responseInfo = await client.request(request);
  if (responseInfo[0].statusCode == 200) {
    const responseObj = responseInfo[0].body as TemplateVersion;
    return responseObj;
  } else {
    console.log(responseInfo[0]);
    throw "Invalid status code";
  }
}

async function createDynamicTemplate(client: Client, templateInfo: TemplateInfo) {
  const existingTemplates = await getExistingTemplates(client, templateInfo.template_id);
  const matches = existingTemplates.filter(
    (item) => item.name == templateInfo.name && item.subject == templateInfo.subject && item.html_content == templateInfo.html
  );
  if (matches.length > 0) {
    if (matches.some((item) => item.active == 1)) {
      console.log(`Found an existing active match for ${templateInfo.name}`);
    } else {
      console.log(`Found an existing non-active match for ${templateInfo.name}-- making active`);
      await activateExistingTemplate(client, matches[0]);
    }
    return;
  } else {
    console.log(`Need to create a new entry for ${templateInfo.name}`);
  }
  const request: ClientRequest = {
    url: `/v3/templates/${templateInfo.template_id}/versions`,
    body: {
      name: templateInfo.name,
      active: 1,
      subject: templateInfo.subject,
      html_content: templateInfo.html,
      test_data: JSON.stringify(templateInfo.test_data, null, 2),
      editor: "design",
    },
    method: "POST",
  };

  const responseInfo = await client.request(request);
  if (responseInfo[0].statusCode == 201) {
    return;
  } else {
    console.log(responseInfo[0]);
    throw "Invalid status code";
  }
}

export async function run(): Promise<void> {
  try {
    const githubWorkspace = process.env.GITHUB_WORKSPACE;
    const sendgridApiKey = process.env.SENDGRID_API_KEY;
    const templateInfoPath = core.getInput("template_info", { required: true });
    const environment = core.getInput("environment", { required: true });
    if (!githubWorkspace) {
      throw new Error(`$SENDGRID_API_KEY is not set`);
    } else if (!sendgridApiKey) {
      throw new Error(`$GITHUB_WORKSPACE is not set`);
    }

    const absoluteRoot = path.resolve(githubWorkspace);
    const absoluteTemplateInfoPath = getAbsoluteTemplateInfoPath(absoluteRoot, templateInfoPath);
    const templateInfo = getTemplateInfo(absoluteTemplateInfoPath);
    const templateInfoEntries = templateInfo
      .filter((item) => environment in item.env_template_id)
      .map((item) => {
        const absoluteHtmlPath = path.resolve(path.dirname(absoluteTemplateInfoPath), item.html);
        const html = fs.readFileSync(absoluteHtmlPath, "utf8");
        return {
          template_id: item.env_template_id[environment],
          name: item.name,
          subject: item.subject,
          html: html,
          test_data: item.test_data,
        };
      });
    const client = new Client();
    client.setApiKey(sendgridApiKey);
    templateInfoEntries.forEach((templateInfo) => createDynamicTemplate(client, templateInfo));
    //console.log(templateInfoEntries);
  } catch (err) {
    core.setFailed(`ubik2/update-sendgrid-templates-action failed with: ${err}`);
  }
}

// Execute this as the entrypoint when requested.
if (require.main === module) {
  run();
}
