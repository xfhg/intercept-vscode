import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

let outputChannel: vscode.OutputChannel;
let resultsPanel: vscode.WebviewPanel | undefined;
let resultsProvider: InterceptResultsProvider;


export function activate(context: vscode.ExtensionContext) {
    console.log('Intercept extension is now active');

    // Initialize the output channel
    outputChannel = vscode.window.createOutputChannel("Intercept");
    context.subscriptions.push(outputChannel);

    resultsProvider = new InterceptResultsProvider();
    vscode.window.registerTreeDataProvider('interceptResultsView', resultsProvider);

    let scanWorkspaceDisposable = vscode.commands.registerCommand('intercept.scanWorkspace', () => {
        runScan(context.extensionUri);
    });

    context.subscriptions.push(scanWorkspaceDisposable);

    let refreshResultsDisposable = vscode.commands.registerCommand('intercept.refreshResults', () => {
        runScan(context.extensionUri);
    });

    context.subscriptions.push(refreshResultsDisposable);

    // Register a file system watcher to trigger scan on save
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidChange((uri) => {
        if (vscode.workspace.getConfiguration('intercept').get('scanOnSave')) {
            runScan(context.extensionUri);
        }
    });

    context.subscriptions.push(watcher);
}


class InterceptResultsProvider implements vscode.TreeDataProvider<ResultItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ResultItem | undefined | null | void> = new vscode.EventEmitter<ResultItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ResultItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private results: ResultItem[] = [];

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ResultItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ResultItem): Thenable<ResultItem[]> {
        if (element) {
            return Promise.resolve([]);
        } else {
            return Promise.resolve(this.results);
        }
    }

    setResults(sarifResults: any) {
        this.results = [];
        for (const run of sarifResults.runs) {
            if (run.results.length === 0 || (run.results.length === 1 && run.results[0].level === 'note')) {
                // Clean scan
                this.results.push(new ResultItem(
                    'Clean Scan',
                    'No issues found',
                    vscode.TreeItemCollapsibleState.None
                ));
            } else {
                for (const result of run.results) {
                    if (result.level === 'note') continue; // Skip note-level results

                    const location = result.locations[0].physicalLocation;
                    const uri = location.artifactLocation.uri;
                    const fileName = path.basename(uri);
                    const lineNumber = location.region.startLine;

                    this.results.push(new ResultItem(
                        `${fileName}:${lineNumber}`,
                        result.message.text,
                        vscode.TreeItemCollapsibleState.None,
                        {
                            command: 'vscode.open',
                            title: 'Open File',
                            arguments: [vscode.Uri.file(uri), { selection: new vscode.Range(lineNumber - 1, 0, lineNumber - 1, 0) }]
                        }
                    ));
                }
            }
        }
        this.refresh();
    }
}


class ResultItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        private version: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly command?: vscode.Command
    ) {
        super(label, collapsibleState);
        this.tooltip = `${this.label}: ${this.version}`;
        this.description = this.version;
    }
}

function runInterceptAudit(folderPath: string, extensionUri: vscode.Uri, progress: vscode.Progress<{ message?: string; increment?: number }>) {
    const interceptPath = vscode.workspace.getConfiguration('intercept').get('executablePath', 'intercept');
    const policyFile = vscode.workspace.getConfiguration('intercept').get('policyFile', '');

    if (!policyFile) {
        vscode.window.showErrorMessage('Intercept policy file not configured');
        return;
    }

    // Create a temporary directory for Intercept output
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intercept-'));

    outputChannel.appendLine(`Running Intercept audit on: ${folderPath}`);
    outputChannel.appendLine(`Using policy file: ${policyFile}`);
    outputChannel.appendLine(`Temporary directory: ${tempDir}`);

    const cmd = `${interceptPath} audit -t "${folderPath}" --policy "${policyFile}" -o "${tempDir}"`;
    outputChannel.appendLine(`Executing command: ${cmd}`);

    cp.exec(cmd, (error, stdout, stderr) => {
        if (error) {
            outputChannel.appendLine(`Intercept audit failed: ${error.message}`);
            outputChannel.appendLine(`stdout: ${stdout}`);
            outputChannel.appendLine(`stderr: ${stderr}`);
            vscode.window.showErrorMessage(`Intercept audit failed. Check Output > Intercept for details.`);
            fs.rmdirSync(tempDir, { recursive: true });
            return;
        }

        outputChannel.appendLine('Intercept audit completed successfully');

        // Read the SARIF output from the temporary directory
        const sarifFiles = fs.readdirSync(tempDir).filter(file => file.endsWith('.sarif.json'));
        outputChannel.appendLine(`SARIF files found: ${sarifFiles.join(', ')}`);

        if (sarifFiles.length === 0) {
            outputChannel.appendLine('No SARIF output found');
            vscode.window.showErrorMessage('No SARIF output found. Check Output > Intercept for details.');
            fs.rmdirSync(tempDir, { recursive: true });
            return;
        }

        const sarifContent = fs.readFileSync(path.join(tempDir, sarifFiles[0]), 'utf8');
        outputChannel.appendLine(`SARIF content: ${sarifContent.substring(0, 200)}...`);

        // Parse the SARIF output and display results
        try {
            const sarifResults = JSON.parse(sarifContent);
            displayResultsInWebView(sarifResults, extensionUri);
            resultsProvider.setResults(sarifResults);  // Update the sidebar view
        } catch (e) {
            outputChannel.appendLine(`Failed to parse Intercept output: ${e}`);
            vscode.window.showErrorMessage('Failed to parse Intercept output. Check Output > Intercept for details.');
        }

        // Clean up the temporary directory
        fs.rmdirSync(tempDir, { recursive: true });
    });
}

function runScan(extensionUri: vscode.Uri) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;
    
    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Running Intercept scan",
        cancellable: true
    }, async (progress, token) => {
        token.onCancellationRequested(() => {
            console.log("User canceled the scan");
        });

        progress.report({ increment: 0 });

        try {
            await runInterceptAudit(rootPath, extensionUri, progress);
            vscode.window.showInformationMessage('Intercept scan completed successfully');
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Intercept scan failed: ${errorMessage}`);
        }
    });
}

function displayResults(sarifResults: any) {
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('intercept');
    diagnosticCollection.clear();

    outputChannel.appendLine(`Displaying results for ${sarifResults.runs.length} run(s)`);

    for (const run of sarifResults.runs) {
        outputChannel.appendLine(`Processing ${run.results.length} result(s) for run`);
        for (const result of run.results) {
            if (!result.locations || result.locations.length === 0) {
                outputChannel.appendLine(`Skipping result without location information`);
                continue;
            }

            const location = result.locations[0].physicalLocation;
            if (!location || !location.artifactLocation || !location.region) {
                outputChannel.appendLine(`Skipping result with incomplete location information`);
                continue;
            }

            const uri = vscode.Uri.file(location.artifactLocation.uri);
            
            // Ensure line and column numbers are non-negative
            const startLine = Math.max(0, (location.region.startLine || 1) - 1);
            const startColumn = Math.max(0, (location.region.startColumn || 1) - 1);
            const endLine = Math.max(startLine, (location.region.endLine || startLine + 1) - 1);
            const endColumn = Math.max(startColumn, (location.region.endColumn || startColumn + 1) - 1);

            outputChannel.appendLine(`Creating range: (${startLine},${startColumn}) to (${endLine},${endColumn})`);

            const range = new vscode.Range(startLine, startColumn, endLine, endColumn);

            const diagnostic = new vscode.Diagnostic(
                range,
                result.message.text,
                vscode.DiagnosticSeverity.Warning
            );

            let diagnostics = diagnosticCollection.get(uri) || [];
            diagnostics = [...diagnostics, diagnostic];
            diagnosticCollection.set(uri, diagnostics);

            outputChannel.appendLine(`Added diagnostic for ${uri.fsPath}: ${result.message.text}`);
        }
    }

    outputChannel.appendLine('Finished displaying results');
}

function displayResultsInWebView(sarifResults: any, extensionUri: vscode.Uri) {
    if (resultsPanel) {
        resultsPanel.reveal(vscode.ViewColumn.Two);
    } else {
        resultsPanel = vscode.window.createWebviewPanel(
            'interceptResults',
            'Intercept Results',
            vscode.ViewColumn.Two,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri]
            }
        );

        resultsPanel.onDidDispose(() => {
            resultsPanel = undefined;
        });
    }

    const webview = resultsPanel.webview;
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));

    const htmlContent = `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Intercept Results</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script>
            tailwind.config = {
                darkMode: 'class',
                theme: {
                    extend: {
                        colors: {
                            'vscode-bg': 'var(--vscode-editor-background)',
                            'vscode-fg': 'var(--vscode-editor-foreground)',
                            'vscode-button-bg': 'var(--vscode-button-background)',
                            'vscode-button-fg': 'var(--vscode-button-foreground)',
                            'vscode-button-hover-bg': 'var(--vscode-button-hoverBackground)',
                            'vscode-link': 'var(--vscode-textLink-foreground)',
                            'vscode-link-hover': 'var(--vscode-textLink-activeForeground)',
                        }
                    }
                }
            }
        </script>
    </head>
    <body class="bg-vscode-bg text-vscode-fg">
        <div class="container mx-auto px-4 py-8">
            <div class="flex justify-between items-center mb-6">
                <h1 class="text-3xl font-bold">Intercept Audit Results</h1>
                <button id="runScanBtn" class="bg-vscode-button-bg text-vscode-button-fg px-4 py-2 rounded hover:bg-vscode-button-hover-bg">
                    Run Scan
                </button>
            </div>
            <div id="results" class="space-y-6">
                ${formatSarifResults(sarifResults)}
            </div>
        </div>
        <script src="${scriptUri}"></script>
    </body>
    </html>`;

    webview.html = htmlContent;

    // Set up the message listener
    const messageListener = webview.onDidReceiveMessage(
        message => {
            switch (message.command) {
                case 'openFile':
                    const uri = vscode.Uri.file(message.uri);
                    vscode.workspace.openTextDocument(uri).then(doc => {
                        vscode.window.showTextDocument(doc).then(editor => {
                            const position = new vscode.Position(message.line - 1, 0);
                            editor.selection = new vscode.Selection(position, position);
                            editor.revealRange(new vscode.Range(position, position));
                        });
                    });
                    return;
                case 'runScan':
                    vscode.commands.executeCommand('intercept.scanWorkspace');
                    return;
            }
        }
    );

    // Dispose the message listener when the panel is disposed
    resultsPanel.onDidDispose(() => messageListener.dispose());
}

function formatSarifResults(sarifResults: any): string {
    let htmlContent = '';

    for (const run of sarifResults.runs) {
        htmlContent += `<div class="bg-vscode-button-bg bg-opacity-10 rounded-lg p-6 mb-6">
            <h2 class="text-2xl font-semibold mb-4">Run: ${run.tool.driver.name}</h2>`;

        if (run.results.length === 0 || (run.results.length === 1 && run.results[0].level === 'note')) {
            // Clean scan
            htmlContent += `
                <div class="text-green-500 font-semibold">
                    Clean Scan: No issues found
                </div>`;
        } else {
            htmlContent += `
            <div class="overflow-x-auto">
                <table class="min-w-full">
                    <thead>
                        <tr class="border-b border-vscode-button-bg border-opacity-20">
                            <th class="px-4 py-2 text-left">Rule</th>
                            <th class="px-4 py-2 text-left">Location</th>
                            <th class="px-4 py-2 text-left">Message</th>
                        </tr>
                    </thead>
                    <tbody>`;

            for (const result of run.results) {
                if (result.level === 'note') continue; // Skip note-level results

                const location = result.locations[0].physicalLocation;
                const uri = location.artifactLocation.uri;
                const fileName = path.basename(uri);
                const region = location.region;
                
                htmlContent += `
                    <tr class="border-b border-vscode-button-bg border-opacity-10 hover:bg-vscode-button-bg hover:bg-opacity-5">
                        <td class="px-4 py-2">${result.ruleId}</td>
                        <td class="px-4 py-2">
                            <a href="#" class="file-link text-vscode-link-hover hover:text-vscode-link" data-uri="${uri}" data-line="${region.startLine}">
                                ${fileName}
                            </a>
                            <span class="text-vscode-fg"> (Line ${region.startLine})</span>
                        </td>
                        <td class="px-4 py-2">${result.message.text}</td>
                    </tr>`;
            }

            htmlContent += `
                    </tbody>
                </table>
            </div>`;
        }

        htmlContent += `</div>`;
    }

    return htmlContent;
}

export function deactivate() {
    if (outputChannel) {
        outputChannel.dispose();
    }
}