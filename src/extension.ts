/**
 * Phan for VS Code Extension
 * 
 * Provides a simple integration with Phan static analyzer to Visual
 * Studio Code. 
 * 
 * NOTE: Phan must be installed (globally) with Composer.
 * 
 * @author Anderson Salas <anderson@ingenia.me>
 * @license MIT
 * 
 * @todo Allow non-composer Phan installations
 */

import * as vscode from 'vscode';
import { TextDocument } from 'vscode';
const cp = require('child_process');
const fs = require('fs');

var prevIssues: any[] = [];
var running = false;

async function showSpinningIcon(force: Boolean = false) 
{
	for (let i = 0; i < (!force ? 1 : 3); i++) {
		if (force) {
			await new Promise(r => setTimeout(r, 50));
		}
		vscode.window.setStatusBarMessage("$(sync~spin) Analysing with Phan...");
	}
}

function hideSpinningIcon() 
{
	vscode.window.setStatusBarMessage(" ");
}

async function invokePhan(collection: vscode.DiagnosticCollection, usePrevious: Boolean = false, singleFile: Boolean = false) 
{
	const config = vscode.workspace.getConfiguration('vsphan');
	const phanPath = config.get<string>('phanPath') || null;
	
	if (phanPath === null) {
		vscode.window.showErrorMessage("You must configure the 'vsphan.phanPath' setting first to use Phan analysis.");
		return;
	}

	let currentFile = vscode.window.activeTextEditor?.document.uri.fsPath;

	if ((currentFile === undefined || currentFile.length === 0) && !singleFile) {
		vscode.window.showInformationMessage("At least one file editor may be open to use this feature");
		return;
	}

	var issues = [];

	if (!usePrevious) {
		if (running) {
			// Avoid to run more than one Phan process at same time
			return;
		}
		await showSpinningIcon(true);
		running = true;
		let args = [];
		let workspaceUrl = vscode.workspace.workspaceFolders !== undefined
			? (vscode.workspace.workspaceFolders[0].uri.fsPath ?? null)
			: null;

		if (!singleFile) {
			args.push('-l');
			args.push(workspaceUrl);
		} else {
			/** 
		     * Single file workaround: here we use the -f <filename> argument to
			 * provide a (dynamically generated) file which contains a single
			 * file path, the currently opened file.
			 * 
			 * @todo: Find the way to use the system temp folder instead of writting
			 *        the file within the local /.phan/ directory
			 */ 
			
			let filePath = workspaceUrl + '/.phan/'; 
			if (!fs.existsSync(filePath)) {
				vscode.window.showErrorMessage("Phan configuration folder '" + filePath + "' does not exists.\nUse phan --init to initialize the workspace");
				hideSpinningIcon();
				running = false;
				return;
			}
			filePath += '.file';
			fs.writeFileSync(filePath,currentFile);
			args.push('-f');	
			args.push(filePath);	
		}

		args.push('--always-exit-successfully-after-analysis');
		args.push('-m');	
		args.push('json');	

		let child = null;

		try {
			child = cp.spawnSync(
				phanPath, 
				args,
				{ 
					maxBuffer: 100 * 1000 * 1000, 
					encoding: 'UTF-8' 
				}
			);
		} catch (e) {
			return;
		}

		running = false;

		if (child.error) {
			vscode.window.showErrorMessage(child.error);
			return;
		}

		issues = JSON.parse(child.stdout.toString());

		if (!singleFile) {
			prevIssues = issues;	
		} 
	} else {
		if (prevIssues.length === 0) {
			hideSpinningIcon();
			return;
		}
		showSpinningIcon();
		issues = prevIssues;
	}

	hideSpinningIcon();

	var newOutput = [];
	var fileIssues = [];
	var fileUrl = null;
	collection.clear();

	if (singleFile) {
		// Single file analysis preserves the other DiagnosticItem objects
		for (let i = 0; i < prevIssues.length; i++) {
			var founded = false;
			for (let j = 0; j < issues.length; j++) {
				var issue = issues[j];
				if (issue.location.path === prevIssues[i].location.path) {
					founded = true;
					break;
				}
			}
			if (founded) {
				continue;
			}
			newOutput.push(prevIssues[i]);
		}
		for (let i = 0; i < issues.length; i++) {
			newOutput.push(issues[i]);	
		}
		prevIssues = newOutput;
	}

	for (let i = 0; i < issues.length; i++) {
		let issue = issues[i];

		if (fileUrl === null || fileUrl !== issue.location.path) {
			if (fileUrl !== null) {
				collection.set(vscode.Uri.file(fileUrl), fileIssues);
			}
			fileUrl = issue.location.path;
			fileIssues = [];
		}

		// For better presentation, all code markers are drawed since the first
		// non-whitespace character, calculated bellow:
		let fromLineNumber = issue.location.lines.begin - 1 < 0 ? 0 : issue.location.lines.begin - 1;
		let toLineNumber = issue.location.lines.end - 1 < 0 ? 0 : issue.location.lines.end - 1;
		let activeTextEditor = vscode.window.activeTextEditor;
		let isCurrentlyOpenedFile = vscode.window.activeTextEditor?.document.fileName === issue.location.path;
		var firstNonWhitespacePos = 0;
		var lastNonWhitespacePos = 999999999;

		if (activeTextEditor !== undefined) {
			if (!isCurrentlyOpenedFile) {
				activeTextEditor = undefined;
				if (usePrevious) {
					continue;
				}
			}
			firstNonWhitespacePos = isCurrentlyOpenedFile
				? activeTextEditor?.document.lineAt(fromLineNumber).firstNonWhitespaceCharacterIndex ?? 0
				: 0;
			lastNonWhitespacePos = isCurrentlyOpenedFile
				? activeTextEditor?.document.lineAt(toLineNumber).range.end.character ?? 0
				: 999999999;
		}

		let range = new vscode.Range(
			new vscode.Position(fromLineNumber, firstNonWhitespacePos ?? 0),
			new vscode.Position(toLineNumber, lastNonWhitespacePos ?? 0)
		);
		fileIssues.push(
			new vscode.Diagnostic(
				range,
				issue.check_name + ': ' + issue.description.replace(issue.check_name,''),
				issue.severity > 5 ? vscode.DiagnosticSeverity.Error : (issue.severity === 5 ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information)
			)
		);
	}

	if (fileIssues.length > 0 && fileUrl !== null) {
		collection.set(vscode.Uri.file(fileUrl), fileIssues);
	}
}

export function activate(context: vscode.ExtensionContext) {
	const collection = vscode.languages.createDiagnosticCollection('phan');
	context.subscriptions.push(vscode.commands.registerCommand('phan-for-vs-code.invokePhanInWorkspace', () => {
		invokePhan(collection);
	}));
	context.subscriptions.push(vscode.commands.registerCommand('phan-for-vs-code.invokePhanInCurrentFile', () => {
		invokePhan(collection, false, true);
	}));
	context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document: TextDocument) => {
		invokePhan(collection, false, true);
	}));
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((e: vscode.TextEditor | undefined) => {
		invokePhan(collection, true, true);
	}));
}

export function deactivate() { }
