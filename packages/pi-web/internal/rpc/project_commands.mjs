const [cwd, agentDir] = sdkArgs;
const { SettingsManager } = await import(new URL('./core/settings-manager.js', pathToFileURL(entry)));
const { DefaultPackageManager } = await import(new URL('./core/package-manager.js', pathToFileURL(entry)));
const { loadSkills } = await import(new URL('./core/skills.js', pathToFileURL(entry)));
const { loadPromptTemplates } = await import(new URL('./core/prompt-templates.js', pathToFileURL(entry)));
const { ProjectTrustStore } = await import(new URL('./core/trust-manager.js', pathToFileURL(entry)));
const { resolveProjectTrusted } = await import(new URL('./core/project-trust.js', pathToFileURL(entry)));
const { createProjectTrustContext } = await import(new URL('./cli/project-trust.js', pathToFileURL(entry)));

// Use Pi's discovery/filter/collision rules without loading extensions or installing packages.
const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
const trusted = await resolveProjectTrusted({
  cwd, trustStore: new ProjectTrustStore(agentDir),
  defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
  projectTrustContext: createProjectTrustContext({ cwd, mode: 'rpc', settingsManager, hasUI: false }),
});
settingsManager.setProjectTrusted(trusted);
await settingsManager.reload();
const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager });
const resources = await packages.resolve(async () => 'skip');
const { skills } = loadSkills({
  cwd, agentDir, includeDefaults: false,
  skillPaths: resources.skills.filter((resource) => resource.enabled).map((resource) => resource.path),
});
const { templates } = loadPromptTemplates({
  cwd, agentDir, includeDefaults: false,
  promptPaths: resources.prompts.filter((resource) => resource.enabled).map((resource) => resource.path),
});
const prompts = templates.filter((template, index) => templates.findIndex((item) => item.name === template.name) === index);
process.stdout.write(JSON.stringify({
  commands: [
    ...(settingsManager.getEnableSkillCommands() ? skills.map((skill) => ({
      name: `skill:${skill.name}`, description: skill.description, source: 'skill',
    })) : []),
    ...prompts.map((prompt) => ({ name: prompt.name, description: prompt.description, source: 'prompt' })),
  ],
}));
