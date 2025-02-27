import { Recipe } from '@shared/models/IRecipe';
import { arch } from 'node:os';
import { GitManager } from './gitManager';
import os from 'os';
import fs from 'fs';
import * as https from 'node:https';
import * as path from 'node:path';
import { containerEngine, ExtensionContext, provider } from '@podman-desktop/api';
import { RecipeStatusRegistry } from '../registries/RecipeStatusRegistry';
import { AIConfig, parseYaml } from '../models/AIConfig';
import { Task } from '@shared/models/ITask';
import { TaskUtils } from '../utils/taskUtils';
import { getParentDirectory } from '../utils/pathUtils';
import { a } from 'vitest/dist/suite-dF4WyktM';
import type { LocalModelInfo } from '@shared/models/ILocalModelInfo';

// TODO: Need to be configured
export const AI_STUDIO_FOLDER = path.join('podman-desktop', 'ai-studio');
export const CONFIG_FILENAME = "ai-studio.yaml";

interface DownloadModelResult {
  result: 'ok' | 'failed';
  error?: string;
}

export class ApplicationManager {
  readonly homeDirectory: string; // todo: make configurable

  constructor(private git: GitManager, private recipeStatusRegistry: RecipeStatusRegistry, private extensionContext: ExtensionContext) {
    this.homeDirectory = os.homedir();
  }

  async pullApplication(recipe: Recipe) {
    // Create a TaskUtils object to help us
    const taskUtil = new TaskUtils(recipe.id, this.recipeStatusRegistry);

    const localFolder = path.join(this.homeDirectory, AI_STUDIO_FOLDER, recipe.id);

    // Adding checkout task
    const checkoutTask: Task = {
      id: 'checkout',
      name: 'Checkout repository',
      state: 'loading',
    }
    taskUtil.setTask(checkoutTask);

    // We might already have the repository cloned
    if(fs.existsSync(localFolder) && fs.statSync(localFolder).isDirectory()) {
      // Update checkout state
      checkoutTask.name = 'Checkout repository (cached).';
      checkoutTask.state = 'success';
    } else {
      // Create folder
      fs.mkdirSync(localFolder, {recursive: true});

      // Clone the repository
      console.log(`Cloning repository ${recipe.repository} in ${localFolder}.`);
      await this.git.cloneRepository(recipe.repository, localFolder);

      // Update checkout state
      checkoutTask.state = 'success';
    }
    // Update task
    taskUtil.setTask(checkoutTask);

    // Adding loading configuration task
    const loadingConfiguration: Task = {
      id: 'loading-config',
      name: 'Loading configuration',
      state: 'loading',
    }
    taskUtil.setTask(loadingConfiguration);

    let configFile: string;
    if(recipe.config !== undefined) {
      configFile = path.join(localFolder, recipe.config);
    } else {
      configFile = path.join(localFolder, CONFIG_FILENAME);
    }

    if(!fs.existsSync(configFile)) {
      loadingConfiguration.state = 'error';
      taskUtil.setTask(loadingConfiguration);
      throw new Error(`The file located at ${configFile} does not exist.`);
    }

    // If the user configured the config as a directory we check for "ai-studio.yaml" inside.
    if(fs.statSync(configFile).isDirectory()) {
      const tmpPath = path.join(configFile, CONFIG_FILENAME);
      // If it has the ai-studio.yaml we use it.
      if(fs.existsSync(tmpPath)) {
        configFile = tmpPath;
      }
    }

    // Parsing the configuration
    console.log(`Reading configuration from ${configFile}.`);
    const rawConfiguration = fs.readFileSync(configFile, 'utf-8');
    let aiConfig: AIConfig;
    try {
      aiConfig = parseYaml(rawConfiguration, arch());
    } catch (err) {
      // Mask task as failed
      loadingConfiguration.state = 'error';
      taskUtil.setTask(loadingConfiguration);
      throw new Error('Cannot load configuration file.');
    }

    // Mark as success
    loadingConfiguration.state = 'success';
    taskUtil.setTask(loadingConfiguration);

    // Getting the provider to use for building
    const connections = provider.getContainerConnections();
    const connection = connections[0];

    // Filter the containers based on architecture
    const filteredContainers = aiConfig.application.containers
      .filter((container) => container.arch === undefined || container.arch === arch())

    // Download first model available (if exist)
    if(recipe.models && recipe.models.length > 0) {
      const model = recipe.models[0];
      taskUtil.setTask({
        id: model.id,
        state: 'loading',
        name: `Downloading model ${model.name}`,
      });

      await this.downloadModelMain(model.id, model.url, taskUtil)
    }

    filteredContainers.forEach((container) => {
      taskUtil.setTask({
        id: container.name,
        state: 'loading',
        name: `Building ${container.name}`,
      })
    });

    // Promise all the build images
    return Promise.all(
      filteredContainers.map((container) =>
        {
          // We use the parent directory of our configFile as the rootdir, then we append the contextDir provided
          const context = path.join(getParentDirectory(configFile), container.contextdir);
          console.log(`Application Manager using context ${context} for container ${container.name}`);

          // Ensure the context provided exist otherwise throw an Error
          if(!fs.existsSync(context)) {
            console.error('The context provided does not exist.');
            taskUtil.setTaskState(container.name, 'error');
            throw new Error('Context configured does not exist.');
          }

          let isErrored = false;
          return containerEngine.buildImage(
            context,
            container.containerfile,
            `${container.name}:latest`,
            '', // keep empty chain so it use default
            connection.connection,
            (event, data) => {
              // todo: do something with the event
              if (event === 'error' || (event === 'finish' && data !== '')) {
                console.error(`Something went wrong while building the image: `, data);
                taskUtil.setTaskState(container.name, 'error');
                isErrored = true;
              }
              if (event === 'finish' && !isErrored) {
                taskUtil.setTaskState(container.name, 'success');            
              }
            }
          ).catch(err => {
            console.error(`Something went wrong while building the image: `, err);
            taskUtil.setTaskState(container.name, 'error');
          });
        }
      )
    )
  }


  downloadModelMain(modelId: string, url: string, taskUtil: TaskUtils, destFileName?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const downloadCallback = (result: DownloadModelResult) => {
        if (result.result) {
          taskUtil.setTaskState(modelId, 'success');
          resolve('');
        } else {
          taskUtil.setTaskState(modelId, 'error');
          reject(result.error)
        }
      }

      this.downloadModel(modelId, url, taskUtil, downloadCallback, destFileName)
    })
  }

  downloadModel(modelId: string, url: string, taskUtil: TaskUtils, callback: (message: DownloadModelResult) => void, destFileName?: string) {
    const destDir = path.join(this.homeDirectory, AI_STUDIO_FOLDER, 'models', modelId);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    if (!destFileName) {
      destFileName =  path.basename(url);
    }
    const destFile = path.resolve(destDir, destFileName);
    const file = fs.createWriteStream(destFile);
    let totalFileSize = 0;
    let progress = 0;
    https.get(url, (resp) => {
      if (resp.headers.location) {
        this.downloadModel(modelId, resp.headers.location, taskUtil, callback, destFileName);
        return;
      } else {
        if (totalFileSize === 0 && resp.headers['content-length']) {
          totalFileSize = parseFloat(resp.headers['content-length']);
        }
      }

      resp.on('data', (chunk) => {
        progress += chunk.length;
        const progressValue = progress * 100 / totalFileSize;

        taskUtil.setTaskProgress(modelId, progressValue);

        // send progress in percentage (ex. 1.2%, 2.6%, 80.1%) to frontend
        //this.sendProgress(progressValue);
        if (progressValue === 100) {
          callback({
            result: 'ok'
          });
        }
      });
      file.on('finish', () => {
        file.close();
      });
      file.on('error', (e) => {
        callback({
          result: 'failed',
          error: e.message,
        });
      })
      resp.pipe(file);
    });
  }

  // todo: move somewhere else (dedicated to models)
  getLocalModels(): LocalModelInfo[] {
    const result: LocalModelInfo[] = [];
    const modelsDir = path.join(this.homeDirectory, AI_STUDIO_FOLDER, 'models');
    const entries = fs.readdirSync(modelsDir, { withFileTypes: true });
    const dirs = entries.filter(dir => dir.isDirectory());
    for (const d of dirs) {
      const modelEntries = fs.readdirSync(path.resolve(d.path, d.name));
      if (modelEntries.length != 1) {
        // we support models with one file only for now
        continue;
      }
      result.push({
        id: d.name,
        file: modelEntries[0],
      })
    }
    return result;
  }
}
