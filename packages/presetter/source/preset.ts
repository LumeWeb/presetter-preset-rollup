/*
 *                            *** MIT LICENSE ***
 * -------------------------------------------------------------------------
 * This code may be modified and distributed under the MIT license.
 * See the LICENSE file for details.
 * -------------------------------------------------------------------------
 *
 * @summary   Procedures for setting up a preset
 *
 * @author    Alvis HT Tang <alvis@hilbert.space>
 * @license   MIT
 * @copyright Copyright (c) 2020 - All Rights Reserved.
 * -------------------------------------------------------------------------
 */

import { info } from 'console';
import { pathExists, writeJSON } from 'fs-extra';
import { defaultsDeep } from 'lodash';
import { dirname, resolve } from 'path';
import resolvePackage from 'resolve-pkg';
import writePackage from 'write-pkg';

import { generateContent, getVariable, resolveContext } from './content';
import { linkFiles, loadFile, unlinkFiles, writeFiles } from './io';
import {
  arePeerPackagesAutoInstalled,
  getPackage,
  reifyDependencies,
} from './package';
import { filter, isJSON, merge, template } from './template';

import type {
  PresetAsset,
  PresetContext,
  PresetterConfig,
  ResolvedPresetContext,
  Template,
} from './types';

/** presetter configuration filename */
const PRESETTERRC = '.presetterrc';

const JSON_INDENT = 2;

/**
 * get the .presetterrc configuration file content
 * @param root the base directory in which the configuration file should be located
 * @returns content of the configuration file
 */
export async function getPresetterRC(root: string): Promise<PresetterConfig> {
  const potentialConfigFiles = ['', '.json'].map((ext) =>
    resolve(root, `${PRESETTERRC}${ext}`),
  );

  for (const path of potentialConfigFiles) {
    if (await pathExists(path)) {
      // return the first customisation file found
      const custom = await loadFile(path, 'json');
      assertPresetterRC(custom);

      return custom;
    }
  }

  // the default preset
  return { preset: 'presetter-preset-essentials' };
}

/**
 * check that the configuration is valid
 * @param value content from a configuration file
 */
export function assertPresetterRC(
  value: unknown,
): asserts value is PresetterConfig {
  if (
    !isJSON(value) ||
    (typeof value['preset'] !== 'string' && !Array.isArray(value['preset']))
  ) {
    throw new Error(`invalid presetter configuration file`);
  }
}

/**
 * get the preset package name from package.json
 * @param context context about the target project and any customisation in .presetterrc
 * @returns name of the preset package
 */
export async function getPresetAssets(
  context: PresetContext,
): Promise<PresetAsset[]> {
  // get the preset name
  const { preset } = context.custom;

  const presets = Array.isArray(preset) ? preset : [preset];

  const assets: PresetAsset[] = [];

  for (const preset of presets) {
    try {
      // get the preset
      const module = resolvePackage(preset, {
        cwd: context.target.root,
      });

      const { default: presetPresetAsset } = (await import(module!)) as {
        default: (args: PresetContext) => Promise<PresetAsset>;
      };

      const asset = await presetPresetAsset(context);

      // add extended assets first
      const extensions =
        asset.extends?.map(async (extension) =>
          getPresetAssets({
            ...context,
            custom: { ...context.custom, preset: extension },
          }),
        ) ?? [];
      assets.push(...(await Promise.all(extensions)).flat());

      // then asset from this preset so that this preset can override the extended ones
      assets.push(asset);
    } catch {
      throw new Error(`cannot resolve preset ${preset}`);
    }
  }

  return assets;
}

/**
 * merge all scripts templates
 * @param context context about the target project and any customisation in .presetterrc
 * @returns scripts template
 */
export async function getScripts(
  context: PresetContext,
): Promise<Record<string, string>> {
  const { custom } = context;

  // get  assets from all configured presets
  const assets = await getPresetAssets(context);

  // compute the final variable to be used in the scripts template
  const variable = getVariable(assets, context);

  // load templated scripts from presets
  const scripts = await Promise.all(
    assets
      .map((asset) => asset.scripts)
      .filter((path): path is string => typeof path === 'string')
      .map(
        async (path) =>
          (await loadFile(path, 'yaml')) as Record<string, string>,
      ),
  );

  // merge all template scripts from presets
  const scriptsFromPreset = scripts.reduce(
    (merged, scripts) => merge(merged, scripts),
    {},
  );

  // merge customised scripts with the preset scripts
  const scriptsWithCustomConfig = merge(scriptsFromPreset, custom.scripts);

  // replace the template variables
  return template(scriptsWithCustomConfig, variable);
}

/**
 *  adopt a preset to the project
 * @param uris list of name or git url of the preset
 */
export async function setupPreset(...uris: string[]): Promise<void> {
  // install presetter & the preset
  info(`Installing ${uris.join(' ')}... it may take a few moment...`);
  const packages = await reifyDependencies({
    root: process.cwd(),
    add: ['presetter', ...uris],
    saveAs: 'dev',
    lockFile: true,
  });

  // extract the name of the preset in case the supplied is a git url
  const preset = uris.map((uri) => {
    const [{ name }] = packages.filter(({ name, spec }) =>
      [name, spec, `${name}@${spec}`].includes(uri),
    );

    return name;
  });

  info('Updating .presetterrc.json & package.json');
  const context = await getContext();
  // update .presetterrc.json
  await writeJSON(
    resolve(context.target.root, `${PRESETTERRC}.json`),
    { preset },
    { spaces: JSON_INDENT },
  );

  // bootstrap configuration files
  await bootstrapContent(context);

  // insert post install script if not preset
  await writePackage(
    context.target.root,
    defaultsDeep(context.target.package, {
      scripts: { prepare: 'presetter bootstrap' },
    }),
  );

  info('Done. Enjoy coding!');
}

/**
 * bootstrap the preset to the current project root
 * @param options options on how to bootstrap the preset
 * @param options.force do all steps despite potential step saving
 */
export async function bootstrapPreset(options?: {
  force?: boolean;
}): Promise<void> {
  const { force = false } = { ...options };

  const context = await getContext();

  // install all related packages first
  if (force || !arePeerPackagesAutoInstalled()) {
    await reifyDependencies({ root: context.target.root });
  }

  // generate configurations
  await bootstrapContent(context);
}

/**
 * generate files from templates and link them to the target project root
 * @param context context about the target project and any customisation in .presetterrc
 */
export async function bootstrapContent(context: PresetContext): Promise<void> {
  const assets = await getPresetAssets(context);
  const content = await generateContent(assets, context);
  const resolvedContext = await resolveContext(assets, context);
  const filteredContent = filter(content, ...(context.custom.ignores ?? []));

  const destinationMap = await getDestinationMap(
    filteredContent,
    resolvedContext,
  );

  await writeFiles(context.target.root, filteredContent, destinationMap);
  await linkFiles(context.target.root, destinationMap);
}

/**
 * uninstall the preset from the current project root
 */
export async function unsetPreset(): Promise<void> {
  const context = await getContext();
  const assets = await getPresetAssets(context);
  const content = await generateContent(assets, context);
  const resolvedContext = await resolveContext(assets, context);
  const configurationLink = await getDestinationMap(content, resolvedContext);

  await unlinkFiles(context.target.root, configurationLink);
}

/**
 * get context about the target project and any customisation in .presetterrc
 * @returns context about the target project and any customisation in .presetterrc
 */
export async function getContext(): Promise<PresetContext> {
  const { json, path } = await getPackage();
  const root = dirname(path);
  const target = { name: json.name, root, package: json };
  const custom = await getPresetterRC(root);

  return {
    target,
    custom,
  };
}

/**
 * compute the output paths of all configuration files to be generated
 * @param template resolved template map
 * @param context resolved context about the target project and customisation
 * @returns mapping of configuration symlinks to its real path
 */
export async function getDestinationMap(
  template: Record<string, Template>,
  context: ResolvedPresetContext<'noSymlinks'>,
): Promise<Record<string, string>> {
  const {
    custom: { noSymlinks },
  } = context;
  const outDir = resolve(__dirname, '..', 'generated', context.target.name);

  const relativePaths = [...Object.keys(template)];

  return Object.fromEntries([
    ...relativePaths.map((relativePath): [string, string] => [
      relativePath,
      resolve(
        // output on the project root if it's specified as not a symlink
        noSymlinks.includes(relativePath) ? context.target.root : outDir,
        relativePath,
      ),
    ]),
  ]);
}
