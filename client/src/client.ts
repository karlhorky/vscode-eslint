
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from 'path';

import {
	workspace as Workspace, window as Window, languages as Languages, Uri, TextDocument, CodeActionContext, Diagnostic, ProviderResult,
	Command, CodeAction, MessageItem, ConfigurationTarget, env as Env, CodeActionKind, WorkspaceConfiguration, NotebookCell, commands, ExtensionContext, StatusBarAlignment, ThemeColor
} from 'vscode';

import {
	LanguageClient, LanguageClientOptions, TransportKind, ErrorHandler, ErrorHandlerResult, CloseAction, CloseHandlerResult,
	RevealOutputChannelOn, ServerOptions, DocumentFilter, DidCloseTextDocumentNotification, DidOpenTextDocumentNotification,
	State, VersionedTextDocumentIdentifier, ExecuteCommandParams, ExecuteCommandRequest, ConfigurationParams, NotebookDocumentSyncRegistrationType
} from 'vscode-languageclient/node';

import { LegacyDirectoryItem, Migration, PatternItem, ValidateItem } from './settings';
import { ExitCalled, NoConfigRequest, NoESLintLibraryRequest, OpenESLintDocRequest, ProbeFailedRequest, ShowOutputChannel, Status, StatusNotification, StatusParams } from './shared/customMessages';
import { CodeActionSettings, CodeActionsOnSaveMode, CodeActionsOnSaveRules, ConfigurationSettings, DirectoryItem, ESLintOptions, ESLintSeverity, ModeItem, PackageManagers, RuleCustomization, RunValues, Validate } from './shared/settings';
import { convert2RegExp, Is, Semaphore, toOSPath, toPosixPath } from './node-utils';
import { pickFolder } from './vscode-utils';

export class Validator {

	private readonly probeFailed: Set<string> = new Set();

	public clear(): void {
		this.probeFailed.clear();
	}

	public add(uri: Uri): void {
		this.probeFailed.add(uri.toString());
	}

	public check(textDocument: TextDocument): Validate {
		const config = Workspace.getConfiguration('eslint', textDocument.uri);
		if (!config.get<boolean>('enable', true)) {
			return Validate.off;
		}
		const languageId = textDocument.languageId;
		const validate = config.get<(ValidateItem | string)[]>('validate');
		if (Array.isArray(validate)) {
			for (const item of validate) {
				if (Is.string(item) && item === languageId) {
					return Validate.on;
				} else if (ValidateItem.is(item) && item.language === languageId) {
					return Validate.on;
				}
			}
		}
		const uri: string = textDocument.uri.toString();
		if (this.probeFailed.has(uri)) {
			return Validate.off;
		}
		const probe: string[] | undefined = config.get<string[]>('probe');
		if (Array.isArray(probe)) {
			for (const item of probe) {
				if (item === languageId) {
					return Validate.probe;
				}
			}
		}
		return Validate.off;
	}
}

type NoESLintState = {
	global?: boolean;
	workspaces?: { [key: string]: boolean };
};

export namespace ESLintClient {

	function migrationFailed(client: LanguageClient, error: any): void {
		client.error(error.message ?? 'Unknown error', error);
		void Window.showErrorMessage('ESLint settings migration failed. Please see the ESLint output channel for further details', 'Open Channel').then((selected) => {
			if (selected === undefined) {
				return;
			}
			client.outputChannel.show();
		});

	}

	export async function migrateSettings(client: LanguageClient): Promise<void> {
		const folders = Workspace.workspaceFolders;
		if (folders === undefined) {
			void Window.showErrorMessage('ESLint settings can only be converted if VS Code is opened on a workspace folder.');
			return;
		}

		const folder = await pickFolder(folders, 'Pick a folder to convert its settings');
		if (folder === undefined) {
			return;
		}
		const migration = new Migration(folder.uri);
		migration.record();
		if (migration.needsUpdate()) {
			try {
				await migration.update();
			} catch (error) {
				migrationFailed(client, error);
			}
		}
	}

	export function create(context: ExtensionContext, validator: Validator): LanguageClient {

		// Filters for client options
		const packageJsonFilter: DocumentFilter = { scheme: 'file', pattern: '**/package.json' };
		const configFileFilter: DocumentFilter = { scheme: 'file', pattern: '**/{.eslintr{c.js,c.yaml,c.yml,c,c.json},eslint.config.js}' };
		const supportedQuickFixKinds: Set<string> = new Set([CodeActionKind.Source.value, CodeActionKind.SourceFixAll.value, `${CodeActionKind.SourceFixAll.value}.eslint`, CodeActionKind.QuickFix.value]);

		// A map of documents synced to the server
		const syncedDocuments: Map<string, TextDocument> = new Map();
		// The actual ESLint client
		const client: LanguageClient = new LanguageClient('ESLint', createServerOptions(context.extensionUri), createClientOptions());

		// The default error handler.
		const defaultErrorHandler: ErrorHandler = client.createDefaultErrorHandler();
		// Whether the server call process.exit() which is intercepted and reported to
		// the client
		let serverCalledProcessExit: boolean = false;

		// A semaphore to ensure we are only running one migration at a time
		const migrationSemaphore: Semaphore<void> = new Semaphore<void>(1);
		// The actual migration code if any.
		let migration: Migration | undefined;
		// Whether migration should happen now
		let notNow: boolean = false;

		// The client's status bar item.
		const statusBarItem = Window.createStatusBarItem('generalStatus', StatusBarAlignment.Right, 0);
		let serverRunning: boolean | undefined;

		const starting = 'ESLint server is starting.';
		const running = 'ESLint server is running.';
		const stopped = 'ESLint server stopped.';
		statusBarItem.name = 'ESLint';
		statusBarItem.text = 'ESLint';
		statusBarItem.command = 'eslint.showOutputChannel';
		const documentStatus: Map<string, Status> = new Map();

		// If the workspace configuration changes we need to update the synced documents since the
		// list of probe language type can change.
		context.subscriptions.push(Workspace.onDidChangeConfiguration(() => {
			validator.clear();
			for (const textDocument of syncedDocuments.values()) {
				if (validator.check(textDocument) === Validate.off) {
					const provider = client.getFeature(DidCloseTextDocumentNotification.method).getProvider(textDocument);
					provider?.send(textDocument).catch((error) => client.error(`Sending close notification failed.`, error));
				}
			}
			for (const textDocument of Workspace.textDocuments) {
				if (!syncedDocuments.has(textDocument.uri.toString()) && validator.check(textDocument) !== Validate.off) {
					const provider = client.getFeature(DidOpenTextDocumentNotification.method).getProvider(textDocument);
					provider?.send(textDocument).catch((error) => client.error(`Sending open notification failed.`, error));
				}
			}
		}));

		client.onNotification(ShowOutputChannel.type, () => {
			client.outputChannel.show();
		});

		client.onNotification(StatusNotification.type, (params) => {
			updateDocumentStatus(params);
		});

		client.onNotification(ExitCalled.type, (params) => {
			serverCalledProcessExit = true;
			client.error(`Server process exited with code ${params[0]}. This usually indicates a misconfigured ESLint setup.`, params[1]);
			void Window.showErrorMessage(`ESLint server shut down itself. See 'ESLint' output channel for details.`, { title: 'Open Output', id: 1}).then((value) => {
				if (value !== undefined && value.id === 1) {
					client.outputChannel.show();
				}
			});
		});

		client.onRequest(NoConfigRequest.type, (params) => {
			const document = Uri.parse(params.document.uri);
			const workspaceFolder = Workspace.getWorkspaceFolder(document);
			const fileLocation = document.fsPath;
			if (workspaceFolder) {
				client.warn([
					'',
					`No ESLint configuration (e.g .eslintrc) found for file: ${fileLocation}`,
					`File will not be validated. Consider running 'eslint --init' in the workspace folder ${workspaceFolder.name}`,
					`Alternatively you can disable ESLint by executing the 'Disable ESLint' command.`
				].join('\n'));
			} else {
				client.warn([
					'',
					`No ESLint configuration (e.g .eslintrc) found for file: ${fileLocation}`,
					`File will not be validated. Alternatively you can disable ESLint by executing the 'Disable ESLint' command.`
				].join('\n'));
			}

			updateDocumentStatus({ uri: params.document.uri, state: Status.error });
			return {};
		});

		client.onRequest(NoESLintLibraryRequest.type, (params) => {
			const key = 'noESLintMessageShown';
			const state = context.globalState.get<NoESLintState>(key, {});

			const uri: Uri = Uri.parse(params.source.uri);
			const workspaceFolder = Workspace.getWorkspaceFolder(uri);
			const packageManager = Workspace.getConfiguration('eslint', uri).get('packageManager', 'npm');
			const localInstall = {
				npm: 'npm install eslint',
				pnpm: 'pnpm install eslint',
				yarn: 'yarn add eslint',
			};
			const globalInstall = {
				npm: 'npm install -g eslint',
				pnpm: 'pnpm install -g eslint',
				yarn: 'yarn global add eslint'
			};
			const isPackageManagerNpm = packageManager === 'npm';
			interface ButtonItem extends MessageItem {
				id: number;
			}
			const outputItem: ButtonItem = {
				title: 'Go to output',
				id: 1
			};
			if (workspaceFolder) {
				client.info([
					'',
					`Failed to load the ESLint library for the document ${uri.fsPath}`,
					'',
					`To use ESLint please install eslint by running ${localInstall[packageManager]} in the workspace folder ${workspaceFolder.name}`,
					`or globally using '${globalInstall[packageManager]}'. You need to reopen the workspace after installing eslint.`,
					'',
					isPackageManagerNpm ? 'If you are using yarn or pnpm instead of npm set the setting `eslint.packageManager` to either `yarn` or `pnpm`' : null,
					`Alternatively you can disable ESLint for the workspace folder ${workspaceFolder.name} by executing the 'Disable ESLint' command.`
				].filter((str => (str !== null))).join('\n'));

				if (state.workspaces === undefined) {
					state.workspaces = {};
				}
				if (!state.workspaces[workspaceFolder.uri.toString()]) {
					state.workspaces[workspaceFolder.uri.toString()] = true;
					void context.globalState.update(key, state);
					void Window.showInformationMessage(`Failed to load the ESLint library for the document ${uri.fsPath}. See the output for more information.`, outputItem).then((item) => {
						if (item && item.id === 1) {
							client.outputChannel.show(true);
						}
					});
				}
			} else {
				client.info([
					`Failed to load the ESLint library for the document ${uri.fsPath}`,
					`To use ESLint for single JavaScript file install eslint globally using '${globalInstall[packageManager]}'.`,
					isPackageManagerNpm ? 'If you are using yarn or pnpm instead of npm set the setting `eslint.packageManager` to either `yarn` or `pnpm`' : null,
					'You need to reopen VS Code after installing eslint.',
				].filter((str => (str !== null))).join('\n'));

				if (!state.global) {
					state.global = true;
					void context.globalState.update(key, state);
					void Window.showInformationMessage(`Failed to load the ESLint library for the document ${uri.fsPath}. See the output for more information.`, outputItem).then((item) => {
						if (item && item.id === 1) {
							client.outputChannel.show(true);
						}
					});
				}
			}
			return {};
		});

		client.onRequest(OpenESLintDocRequest.type, async (params) => {
			await commands.executeCommand('vscode.open', Uri.parse(params.url));
			return {};
		});

		client.onRequest(ProbeFailedRequest.type, (params) => {
			validator.add(client.protocol2CodeConverter.asUri(params.textDocument.uri));
			const closeFeature = client.getFeature(DidCloseTextDocumentNotification.method);
			for (const document of Workspace.textDocuments) {
				if (document.uri.toString() === params.textDocument.uri) {
					closeFeature.getProvider(document)?.send(document).catch((error) => client.error(`Sending close notification failed`, error));
				}
			}
		});

		const notebookFeature = client.getFeature(NotebookDocumentSyncRegistrationType.method);
		if (notebookFeature !== undefined) {
			notebookFeature.register({
				id: String(Date.now()),
				registerOptions: {
					notebookSelector: [{
						notebook: { scheme: 'file' },
						// We dynamically filter using the filterCells callback.
						// To force the filtering match all cells for now.
						// See also https://github.com/microsoft/vscode-languageserver-node/issues/1017
						cells: [ { language: '*' } ]
					}]
				}
			});
		}

		client.onDidChangeState((event) => {
			if (event.newState === State.Starting) {
				client.info('ESLint server is starting');
				serverRunning = undefined;
			} else if (event.newState === State.Running) {
				client.info(running);
				serverRunning = true;
			} else {
				client.info(stopped);
				serverRunning = false;
			}
			updateStatusBar(undefined);
		});

		context.subscriptions.push(
			Window.onDidChangeActiveTextEditor(() => {
				updateStatusBar(undefined);
			}),
			Workspace.onDidCloseTextDocument((document) => {
				const uri = document.uri.toString();
				documentStatus.delete(uri);
				updateStatusBar(undefined);
			}),
			commands.registerCommand('eslint.executeAutofix', async () => {
				const textEditor = Window.activeTextEditor;
				if (!textEditor) {
					return;
				}
				const textDocument: VersionedTextDocumentIdentifier = {
					uri: textEditor.document.uri.toString(),
					version: textEditor.document.version
				};
				const params: ExecuteCommandParams = {
					command: 'eslint.applyAllFixes',
					arguments: [textDocument]
				};
				await client.start();
				client.sendRequest(ExecuteCommandRequest.type, params).then(undefined, () => {
					void Window.showErrorMessage('Failed to apply ESLint fixes to the document. Please consider opening an issue with steps to reproduce.');
				});
			})
		);

		return client;

		function createServerOptions(extensionUri: Uri): ServerOptions {
			const serverModule = Uri.joinPath(extensionUri, 'server', 'out', 'eslintServer.js').fsPath;
			const eslintConfig = Workspace.getConfiguration('eslint');
			const debug = sanitize(eslintConfig.get<boolean>('debug', false) ?? false, 'boolean', false);
			const runtime = sanitize(eslintConfig.get<string | null>('runtime', null) ?? undefined, 'string', undefined);
			const execArgv = sanitize(eslintConfig.get<string[] | null>('execArgv', null) ?? undefined, 'string', undefined);
			const nodeEnv = sanitize(eslintConfig.get<string | null>('nodeEnv', null) ?? undefined, 'string', undefined);

			let env: { [key: string]: string | number | boolean } | undefined;
			if (debug) {
				env = env || {};
				env.DEBUG = 'eslint:*,-eslint:code-path';
			}
			if (nodeEnv !== undefined) {
				env = env || {};
				env.NODE_ENV = nodeEnv;
			}
			const debugArgv = ['--nolazy', '--inspect=6011'];
			const result: ServerOptions = {
				run: { module: serverModule, transport: TransportKind.ipc, runtime, options: { execArgv, cwd: process.cwd(), env } },
				debug: { module: serverModule, transport: TransportKind.ipc, runtime, options: { execArgv: execArgv !== undefined ? execArgv.concat(debugArgv) : debugArgv, cwd: process.cwd(), env } }
			};
			return result;
		}

		function sanitize<T, D>(value: T, type: 'bigint' | 'boolean' | 'function' | 'number' | 'object' | 'string' | 'symbol' | 'undefined', def: D): T | D {
			if (Array.isArray(value)) {
				return value.filter(item => typeof item === type) as unknown as T;
			} else if (typeof value !== type) {
				return def;
			}
			return value;
		}

		function createClientOptions(): LanguageClientOptions {
			const clientOptions: LanguageClientOptions = {
				documentSelector: [{ scheme: 'file' }, { scheme: 'untitled' }],
				diagnosticCollectionName: 'eslint',
				revealOutputChannelOn: RevealOutputChannelOn.Never,
				initializationOptions: {
				},
				progressOnInitialization: true,
				synchronize: {
					fileEvents: [
						Workspace.createFileSystemWatcher('**/.eslintr{c.js,c.cjs,c.yaml,c.yml,c,c.json}'),
						Workspace.createFileSystemWatcher('**/eslint.config.js'),
						Workspace.createFileSystemWatcher('**/.eslintignore'),
						Workspace.createFileSystemWatcher('**/package.json')
					]
				},
				initializationFailedHandler: (error) => {
					client.error('Server initialization failed.', error);
					client.outputChannel.show(true);
					return false;
				},
				errorHandler: {
					error: (error, message, count): ErrorHandlerResult => {
						return defaultErrorHandler.error(error, message, count);
					},
					closed: (): CloseHandlerResult => {
						if (serverCalledProcessExit) {
							return { action: CloseAction.DoNotRestart };
						}
						return defaultErrorHandler.closed();
					}
				},
				middleware: {
					didOpen: async (document, next) => {
						if (Languages.match(packageJsonFilter, document) || Languages.match(configFileFilter, document) || validator.check(document) !== Validate.off) {
							const result = next(document);
							syncedDocuments.set(document.uri.toString(), document);
							return result;
						}
					},
					didChange: async (event, next) => {
						if (syncedDocuments.has(event.document.uri.toString())) {
							return next(event);
						}
					},
					willSave: async (event, next) => {
						if (syncedDocuments.has(event.document.uri.toString())) {
							return next(event);
						}
					},
					willSaveWaitUntil: (event, next) => {
						if (syncedDocuments.has(event.document.uri.toString())) {
							return next(event);
						} else {
							return Promise.resolve([]);
						}
					},
					didSave: async (document, next) => {
						if (syncedDocuments.has(document.uri.toString())) {
							return next(document);
						}
					},
					didClose: async (document, next) => {
						const uri = document.uri.toString();
						if (syncedDocuments.has(uri)) {
							syncedDocuments.delete(uri);
							return next(document);
						}
					},
					notebooks: {
						didOpen: (notebookDocument, cells, next) => {
							const result = next(notebookDocument, cells);
							for (const cell of cells) {
								syncedDocuments.set(cell.document.uri.toString(), cell.document);
							}
							return result;
						},
						didChange: (event, next) => {
							if (event.cells?.structure?.didOpen !== undefined) {
								for (const open of event.cells.structure.didOpen) {
									syncedDocuments.set(open.document.uri.toString(), open.document);
								}
							}
							if (event.cells?.structure?.didClose !== undefined) {
								for (const closed of event.cells.structure.didClose) {
									syncedDocuments.delete(closed.document.uri.toString());
								}
							}
							return next(event);
						},
						didClose: (document, cells, next) => {
							for (const cell of cells) {
								const key = cell.document.uri.toString();
								syncedDocuments.delete(key);
							}
							return next(document, cells);
						}
					},
					provideCodeActions: (document, range, context, token, next): ProviderResult<(Command | CodeAction)[]> => {
						if (!syncedDocuments.has(document.uri.toString())) {
							return [];
						}
						if (context.only !== undefined && !supportedQuickFixKinds.has(context.only.value)) {
							return [];
						}
						if (context.only === undefined && (!context.diagnostics || context.diagnostics.length === 0)) {
							return [];
						}
						const eslintDiagnostics: Diagnostic[] = [];
						for (const diagnostic of context.diagnostics) {
							if (diagnostic.source === 'eslint') {
								eslintDiagnostics.push(diagnostic);
							}
						}
						if (context.only === undefined && eslintDiagnostics.length === 0) {
							return [];
						}
						const newContext: CodeActionContext = Object.assign({}, context, { diagnostics: eslintDiagnostics });
						return next(document, range, newContext, token);
					},
					workspace: {
						didChangeWatchedFile: (event, next) => {
							validator.clear();
							return next(event);
						},
						didChangeConfiguration: async (sections, next) => {
							if (migration !== undefined && (sections === undefined || sections.length === 0)) {
								migration.captureDidChangeSetting(() => {
									return next(sections);
								});
							} else {
								return next(sections);
							}
						},
						configuration: (params) => {
							return readConfiguration(params);
						}
					}
				},
				notebookDocumentOptions: {
					filterCells: (_notebookDocument, cells) => {
						const result: NotebookCell[] = [];
						for (const cell of cells) {
							const document = cell.document;
							if (Languages.match(packageJsonFilter, document) || Languages.match(configFileFilter, document) || validator.check(document) !== Validate.off) {
								result.push(cell);
							}
						}
						return result;
					}
				}
			};
			return clientOptions;
		}

		async function readConfiguration(params: ConfigurationParams): Promise<(ConfigurationSettings | null)[]> {
			if (params.items === undefined) {
				return [];
			}
			const result: (ConfigurationSettings | null)[] = [];
			for (const item of params.items) {
				if (item.section || !item.scopeUri) {
					result.push(null);
					continue;
				}
				const resource = client.protocol2CodeConverter.asUri(item.scopeUri);
				const textDocument = getTextDocument(resource);
				const config = Workspace.getConfiguration('eslint', textDocument ?? resource);
				const workspaceFolder = resource.scheme === 'untitled'
					? Workspace.workspaceFolders !== undefined ? Workspace.workspaceFolders[0] : undefined
					: Workspace.getWorkspaceFolder(resource);
				await migrationSemaphore.lock(async () => {
					const globalMigration = Workspace.getConfiguration('eslint').get('migration.2_x', 'on');
					if (notNow === false && globalMigration === 'on') {
						try {
							migration = new Migration(resource);
							migration.record();
							interface Item extends MessageItem {
								id: 'yes' | 'no' | 'readme' | 'global' | 'local';
							}
							if (migration.needsUpdate()) {
								const folder = workspaceFolder?.name;
								const file = path.basename(resource.fsPath);
								const selected = await Window.showInformationMessage<Item>(
									[
										`The ESLint 'autoFixOnSave' setting needs to be migrated to the new 'editor.codeActionsOnSave' setting`,
										folder !== undefined ? `for the workspace folder: ${folder}.` : `for the file: ${file}.`,
										`For compatibility reasons the 'autoFixOnSave' remains and needs to be removed manually.`,
										`Do you want to migrate the setting?`
									].join(' '),
									{ modal: true},
									{ id: 'yes', title: 'Yes'},
									{ id: 'global', title: 'Never migrate Settings' },
									{ id: 'readme', title: 'Open Readme' },
									{ id: 'no', title: 'Not now', isCloseAffordance: true }
								);
								if (selected !== undefined) {
									if (selected.id === 'yes') {
										try {
											await migration.update();
										} catch (error) {
											migrationFailed(client, error);
										}
									} else if (selected.id === 'no') {
										notNow = true;
									} else if (selected.id === 'global') {
										await config.update('migration.2_x', 'off', ConfigurationTarget.Global);
									} else if (selected.id === 'readme') {
										notNow = true;
										void Env.openExternal(Uri.parse('https://github.com/microsoft/vscode-eslint#settings-migration'));
									}
								}
							}
						} finally {
							migration = undefined;
						}
					}
				});
				const settings: ConfigurationSettings = {
					validate: Validate.off,
					packageManager: config.get<PackageManagers>('packageManager', 'npm'),
					useESLintClass: config.get<boolean>('useESLintClass', false),
					experimentalUseFlatConfig: config.get<boolean>('experimentalUseFlatConfig', false),
					codeActionOnSave: {
						mode: CodeActionsOnSaveMode.all
					},
					format: false,
					quiet: config.get<boolean>('quiet', false),
					onIgnoredFiles: ESLintSeverity.from(config.get<string>('onIgnoredFiles', ESLintSeverity.off)),
					options: config.get<ESLintOptions>('options', {}),
					rulesCustomizations: getRuleCustomizations(config, resource),
					run: config.get<RunValues>('run', 'onType'),
					nodePath: config.get<string | undefined>('nodePath', undefined) ?? null,
					workingDirectory: undefined,
					workspaceFolder: undefined,
					codeAction: {
						disableRuleComment: config.get<CodeActionSettings['disableRuleComment']>('codeAction.disableRuleComment', { enable: true, location: 'separateLine' as const, commentStyle: 'line' as const }),
						showDocumentation: config.get<CodeActionSettings['showDocumentation']>('codeAction.showDocumentation', { enable: true })
					}
				};
				const document: TextDocument | undefined = syncedDocuments.get(item.scopeUri);
				if (document === undefined) {
					result.push(settings);
					continue;
				}
				if (config.get<boolean>('enabled', true)) {
					settings.validate = validator.check(document);
				}
				if (settings.validate !== Validate.off) {
					settings.format = !!config.get<boolean>('format.enable', false);
					settings.codeActionOnSave.mode = CodeActionsOnSaveMode.from(config.get<CodeActionsOnSaveMode>('codeActionsOnSave.mode', CodeActionsOnSaveMode.all));
					settings.codeActionOnSave.rules = CodeActionsOnSaveRules.from(config.get<string[] | null>('codeActionsOnSave.rules', null));
				}
				if (workspaceFolder !== undefined) {
					settings.workspaceFolder = {
						name: workspaceFolder.name,
						uri: client.code2ProtocolConverter.asUri(workspaceFolder.uri)
					};
				}
				const workingDirectories = config.get<(string | LegacyDirectoryItem | DirectoryItem | PatternItem | ModeItem)[] | undefined>('workingDirectories', undefined);
				if (Array.isArray(workingDirectories)) {
					let workingDirectory: ModeItem | DirectoryItem | undefined = undefined;
					const workspaceFolderPath = workspaceFolder && workspaceFolder.uri.scheme === 'file' ? workspaceFolder.uri.fsPath : undefined;
					for (const entry of workingDirectories) {
						let directory: string | undefined;
						let pattern: string | undefined;
						let noCWD = false;
						if (Is.string(entry)) {
							directory = entry;
						} else if (LegacyDirectoryItem.is(entry)) {
							directory = entry.directory;
							noCWD = !entry.changeProcessCWD;
						} else if (DirectoryItem.is(entry)) {
							directory = entry.directory;
							if (entry['!cwd'] !== undefined) {
								noCWD = entry['!cwd'];
							}
						} else if (PatternItem.is(entry)) {
							pattern = entry.pattern;
							if (entry['!cwd'] !== undefined) {
								noCWD = entry['!cwd'];
							}
						} else if (ModeItem.is(entry)) {
							workingDirectory = entry;
							continue;
						}

						let itemValue: string | undefined;
						if (directory !== undefined || pattern !== undefined) {
							const filePath = document.uri.scheme === 'file' ? document.uri.fsPath : undefined;
							if (filePath !== undefined) {
								if (directory !== undefined) {
									directory = toOSPath(directory);
									if (!path.isAbsolute(directory) && workspaceFolderPath !== undefined) {
										directory = path.join(workspaceFolderPath, directory);
									}
									if (directory.charAt(directory.length - 1) !== path.sep) {
										directory = directory + path.sep;
									}
									if (filePath.startsWith(directory)) {
										itemValue = directory;
									}
								} else if (pattern !== undefined && pattern.length > 0) {
									if (!path.posix.isAbsolute(pattern) && workspaceFolderPath !== undefined) {
										pattern = path.posix.join(toPosixPath(workspaceFolderPath), pattern);
									}
									if (pattern.charAt(pattern.length - 1) !== path.posix.sep) {
										pattern = pattern + path.posix.sep;
									}
									const regExp: RegExp | undefined = convert2RegExp(pattern);
									if (regExp !== undefined) {
										const match = regExp.exec(filePath);
										if (match !== null && match.length > 0) {
											itemValue = match[0];
										}
									}
								}
							}
						}
						if (itemValue !== undefined) {
							if (workingDirectory === undefined || ModeItem.is(workingDirectory)) {
								workingDirectory = { directory: itemValue, '!cwd': noCWD };
							} else {
								if (workingDirectory.directory.length < itemValue.length) {
									workingDirectory.directory = itemValue;
									workingDirectory['!cwd'] = noCWD;
								}
							}
						}
					}
					settings.workingDirectory = workingDirectory;
				}
				result.push(settings);
			}
			return result;
		}

		function parseRulesCustomizations(rawConfig: unknown): RuleCustomization[] {
			if (!rawConfig || !Array.isArray(rawConfig)) {
				return [];
			}

			return rawConfig.map(rawValue => {
				if (typeof rawValue.severity === 'string' && typeof rawValue.rule === 'string') {
					return {
						severity: rawValue.severity,
						rule: rawValue.rule,
					};
				}

				return undefined;
			}).filter((value): value is RuleCustomization => !!value);
		}

		function getRuleCustomizations(config: WorkspaceConfiguration, uri: Uri): RuleCustomization[] {
			let customizations: RuleCustomization[] | undefined = undefined;
			if (uri.scheme === 'vscode-notebook-cell') {
				customizations = config.get<RuleCustomization[] | undefined>('notebooks.rules.customizations', undefined);
			}
			if (customizations === undefined || customizations === null) {
				customizations = config.get<RuleCustomization[] | undefined>('rules.customizations');
			}
			return parseRulesCustomizations(customizations);
		}

		function getTextDocument(uri: Uri): TextDocument | undefined {
			return syncedDocuments.get(uri.toString());
		}

		function updateDocumentStatus(params: StatusParams): void {
			documentStatus.set(params.uri, params.state);
			updateStatusBar(params.uri);
		}

		function updateStatusBar(uri: string | undefined) {
			const status = function() {
				if (serverRunning === false) {
					return Status.error;
				}
				if (uri === undefined) {
					uri = Window.activeTextEditor?.document.uri.toString();
				}
				return (uri !== undefined ? documentStatus.get(uri) : undefined) ?? Status.ok;
			}();
			let icon: string| undefined;
			let tooltip: string | undefined;
			let text: string = 'ESLint';
			let backgroundColor: ThemeColor | undefined;
			let foregroundColor: ThemeColor | undefined;
			switch (status) {
				case Status.ok:
					icon = undefined;
					foregroundColor = new ThemeColor('statusBarItem.foreground');
					backgroundColor = new ThemeColor('statusBarItem.background');
					break;
				case Status.warn:
					icon = '$(alert)';
					foregroundColor = new ThemeColor('statusBarItem.warningForeground');
					backgroundColor = new ThemeColor('statusBarItem.warningBackground');
					break;
				case Status.error:
					icon = '$(issue-opened)';
					foregroundColor = new ThemeColor('statusBarItem.errorForeground');
					backgroundColor = new ThemeColor('statusBarItem.errorBackground');
					break;
			}
			statusBarItem.text = icon !== undefined ? `${icon} ${text}` : text;
			statusBarItem.color = foregroundColor;
			statusBarItem.backgroundColor = backgroundColor;
			statusBarItem.tooltip = tooltip ? tooltip : serverRunning === undefined ? starting : serverRunning === true ? running : stopped;
			const alwaysShow = Workspace.getConfiguration('eslint').get('alwaysShowStatus', false);
			if (alwaysShow || status !== Status.ok) {
				statusBarItem.show();
			} else {
				statusBarItem.hide();
			}
		}
	}
}