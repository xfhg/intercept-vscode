(function() {
    const vscode = acquireVsCodeApi();
    
    // Handle theme changes
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.type) {
            case 'theme-changed':
                if (message.theme.kind === 'dark') {
                    document.documentElement.classList.add('dark');
                } else {
                    document.documentElement.classList.remove('dark');
                }
                break;
        }
    });

    // Handle file link clicks
    document.addEventListener('click', function(event) {
        if (event.target.classList.contains('file-link')) {
            event.preventDefault();
            const uri = event.target.getAttribute('data-uri');
            const line = parseInt(event.target.getAttribute('data-line'), 10);
            vscode.postMessage({
                command: 'openFile',
                uri: uri,
                line: line
            });
        }
    });

    // Handle Run Scan button click
    document.getElementById('runScanBtn').addEventListener('click', function() {
        vscode.postMessage({
            command: 'runScan'
        });
    });
})();