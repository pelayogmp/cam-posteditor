/*
  Copyright (c) 2017 by Autodesk, Inc.

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in
  all copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
*/

// pull the relevant node modules
const vscode = require('vscode');
let QuickPickOptions = vscode.QuickPickOptions;
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const process = require('process');
// require the sidebar JS files
const functionNodes = require('./functionList');
const variableList = require('./variableList');
const CNCList = require('./cncList');
const properties = require('./properties');
// store the file information when posting
let cncFile = undefined;
let postFile = undefined;
let postLoc = undefined;
let lineData = [];
// find and store the location for the application resources
const resLocation = vscode.extensions.getExtension("Autodesk.hsm-post-processor").extensionPath + "\\res";
// store the OS temporary directory
const tmp = os.tmpdir();
// set a location for the custom CNC Files
const customCNC = tmp + "\\Autodesk\\VSCode\\CustomCNCFiles";
// define location for the settings file. Used to store the post.exe location
const settingsLocation = resLocation + "\\settings.json";
// set a location for post properties
const propertyJSONpath = tmp + "\\Autodesk\\VSCode\\Properties\\";
let tmpCPSFile = [];
// checks if the same output line has been selected, if it has, the code will jump to the next parent line
let lastSelectedLine = undefined;
let amountToMove = 0;
// if enabled, auto line-selection will occur (when selecting a line in the outputted code)
let enableLineSelection = vscode.workspace.getConfiguration("HSMPostUtility").get("enableAutoLineSelection");
// used to determine whether to show the full debugged code output, or just the generated code
let showDebugOutput = false;
// set the output paths
const outputpath = tmp + "\\debuggedfile.nc";
const logPath = tmp + "\\debuggedfile.log";
const debugOutputpath = tmp + "\\debuggedfile.nc2";
let ListItems = undefined;
// set the location of the stored CNC files
const cncFilesLocation = resLocation + "\\CNC files";
let units = 1;
let config = vscode.workspace.getConfiguration("HSMPostUtility");

function activate(context) {
  if (process.platform != "win32") {
    vscode.window.showErrorMessage("The Autodesk Post Processor Utility is only supported on Windows.");
    return;
  }

  vscode.workspace.onDidCloseTextDocument((doc) => {
    var cpsPath = doc.fileName.toString();
    var hash = crypto.createHash('md5').update(cpsPath).digest('hex');
    var jsonPath = propertyJSONpath + hash + ".json";
    if (fs.existsSync(jsonPath)) {
      fs.unlinkSync(jsonPath);
      propertyTree.refresh();
    }
  });

  // set an event handler for the saving of a document. This is used to post on-save
  vscode.workspace.onDidSaveTextDocument(savedoc);
  vscode.window.onDidChangeActiveTextEditor(checkForAutoComplete);
  vscode.window.onDidChangeTextEditorSelection(handleChange);
  checkForAutoComplete();
  copyCNCFiles();
  // if the custom CNC directory exists, check each file
  if (fs.existsSync(customCNC) && !fs.existsSync(resLocation + "\\CNC files\\Custom")) {
    let cncFiles = fs.readdirSync(customCNC);
    let tempList = [];
    fs.mkdirSync(resLocation + "\\CNC files\\Custom");
    for (var i = 0; i < cncFiles.length; ++i) {
      if (cncFiles[i].toLocaleLowerCase().includes(".cnc")) {
        let copyLocation = resLocation + "\\CNC files\\Custom\\" + cncFiles[i];
        copyFile(customCNC + "\\" + cncFiles[i], copyLocation);
      }
    }
    let filesToMove = [];
  }

  // update the configuration to include the CPS extension
  let currentLanguageConfiguration = vscode.workspace.getConfiguration("files").get("associations");
  let stringLang = "";
  if (currentLanguageConfiguration) stringLang = JSON.stringify(currentLanguageConfiguration);
  if (!stringLang.toLowerCase().includes("*.cps")) {
    let obj = '"*.cps": "javascript"';
    if (currentLanguageConfiguration) {
      let tempLanguage = JSON.stringify(currentLanguageConfiguration);
      tempLanguage = tempLanguage.substr(0, tempLanguage.length - 1);
      if (tempLanguage.includes(":")) {
        tempLanguage += ",";
      }
      tempLanguage += obj + "}";
      currentLanguageConfiguration = JSON.parse(tempLanguage);
    } else {
      currentLanguageConfiguration = JSON.parse(obj);
    }
    vscode.workspace.getConfiguration("files").update("associations", currentLanguageConfiguration, true);
  }

  const cncTree = new CNCList.cncDataProvider(context);
  vscode.window.registerTreeDataProvider('cncList', cncTree);

  const propertyTree = new properties.propertyDataProvider(context);
  vscode.window.registerTreeDataProvider('propertyList', propertyTree);

  context.subscriptions.push(vscode.commands.registerCommand('propertyList.refreshPropertyList', () => {
    propertyTree.refresh();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('propertyList.checkForDifferences', () => {
    propertyTree.checkForDifferences(false);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('propertyList.initializePropertyList', () => {
    if (getCpsPath() != undefined) {
      if (fs.existsSync(settingsLocation)) {
        var lines = fs.readFileSync(settingsLocation);
        if (lines.length > 1) {
          var sett = JSON.parse(lines);
          if (sett.postLocation) {
            postLoc = sett.postLocation;
          } else {
            locatePostEXE(true);
          }
        }
      } else {
        locatePostEXE(true);
      }
      propertyTree.refreshTree(); // initialize json data
    }
  }));

  const varList = new variableList.variableListDataProvider(context);
  vscode.window.registerTreeDataProvider('variableList', varList);

  context.subscriptions.push(vscode.commands.registerCommand('variableList.searchVars', () => {
    var inputOpts = vscode.InputBoxOptions;
    var opts = inputOpts = {placeHolder: "Enter your search term"};
    vscode.window.showInputBox(opts).then(result => {
      varList._filter(result);
    });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('variableList.clearSearch', () => {
    varList._refreshTree();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('hsm.deleteCNCFile', (element) => {
    if (!element) {
      vscode.window.showErrorMessage("This command can only be executed from the CNC selector tree");
      return;
    }
    let src = element.src;
    fs.unlinkSync(src);
    if (fs.existsSync(customCNC + "\\" + path.basename(src))) {
      fs.unlinkSync(customCNC + "\\" + path.basename(src));
    }
    vscode.window.showInformationMessage(element.label + " deleted");
    cncTree.refreshTree();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('hsm.openFolder', (element) => {
    if (!element) {
      vscode.window.showErrorMessage("This command can only be executed from the CNC selector tree");
      return;
    }
    let folderLocation = cncFilesLocation + "\\" + element.label;
    require('child_process').exec('start "" "' + folderLocation + '"');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('hsm.importCNC', (element) => {
    if (!element) {
      vscode.window.showErrorMessage("This command can only be executed from the CNC selector tree");
      return;
    }
    if (!fs.existsSync(resLocation + "\\CNC files\\Custom")) {
      fs.mkdirSync(resLocation + "\\CNC files\\Custom");
      vscode.window.setStatusBarMessage("Custom CNC folder created", 2000);
    }
    var log = "";
    vscode.window.showOpenDialog({openFiles: true, canSelectMany: true, filters: {'HSM intermediate file': ['cnc']}}).then((val) => {
      for (var i = 0; i < val.length; ++i) {
      var selectedPath = val[i].path.substr(1, val[i].path.length);
      if (fs.existsSync(selectedPath)) {
        let copyLocation = resLocation + "\\CNC files\\Custom\\" + path.basename(selectedPath);
        copyFile(selectedPath, copyLocation);
        let separator = "";
        if (i < val.length -1) {
          separator = ", ";
        }
        log+= "\"" + path.basename(selectedPath) + "\"" + separator;
      } else {
        vscode.window.showErrorMessage("Import of CNC file(s) failed.");
        return;
      }
    }
    cncTree.refreshTree();
    vscode.window.showInformationMessage("CNC file(s) " + log + " successfully imported.");
    });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('hsm.changePostExe', () => {
      locatePostEXE(false);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("hsm.findPostExe", () => {
    locatePostEXE(true);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("hsm.changeProperty", (element) => {
    if (!element) {
      vscode.window.showErrorMessage("This command can only be executed from the Post Properties tree.");
      return;
    }
    SelectItem(element, false);
  }));

  context.subscriptions.push(vscode.commands.registerCommand("hsm.resetProperty", (element) => {
    if (!element) {
      vscode.window.showErrorMessage("This command can only be executed from the Post Properties tree.");
      return;
    }
    SelectItem(element, true);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('hsm.directSelect', element  => {
      SelectItem(element, false);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('hsm.downloadCNCExtractor', () => {
    const ncToCopy = resLocation + "\\export cnc file to vs code.cps";
    var uri = vscode.Uri.file(ncToCopy);
    uri.path = os.userInfo().homedir.toString() + '\\export cnc file to vs code.cps';
    vscode.window.showSaveDialog({filters: {'HSM Post Processor': ['cps']}, defaultUri: uri}).then(val => {
      if (val) {
        fs.createReadStream(ncToCopy).pipe(fs.createWriteStream(val.path.substr(1, val.path.length)));
        vscode.window.showInformationMessage("Post saved");
      }
    });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('cncList.refreshCNCList', () => {
    cncTree.refreshTree();
    copyCNCFiles();
  }));

  context.subscriptions.push(vscode.commands.registerCommand('hsm.enableAutoComplete', () => {
    setAutoComplete(true);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('hsm.disableAutoComplete', () => {
    setAutoComplete(false);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('hsm.setCNC', selectedFile => {
    if (selectedFile.toLowerCase().includes(".cnc")) {
      cncFile = selectedFile;
      vscode.window.setStatusBarMessage("CNC file set", 2000);
      config = vscode.workspace.getConfiguration("HSMPostUtility");
      var postOnSelection = config.get("postOnCNCSelection");
      if (postOnSelection) {
        vscode.commands.executeCommand('HSM.postProcess');
      }
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('hsm.showDebuggedCode', () => {
    vscode.window.showQuickPick(["True", "False"]).then(val => {
      if (val == "True") {
        showDebugOutput = true;
        enableLineSelection = false;
      } else if (val == "False") {
        showDebugOutput = false;
        enableLineSelection = vscode.workspace.getConfiguration("HSMPostUtility").get("enableAutoLineSelection");
      }
    });
  }));

  context.subscriptions.push(vscode.commands.registerCommand('hsm.disableLineSelection', () => {
    vscode.window.showQuickPick(["True", "False"]).then(val => {
      if (val == "True") {
        vscode.workspace.getConfiguration("HSMPostUtility").update("enableAutoLineSelection", false);
        enableLineSelection = false;
      } else if (val == "False") {
        vscode.workspace.getConfiguration("HSMPostUtility").update("enableAutoLineSelection", true);
        if (!showDebugOutput) {
          enableLineSelection = true;
        }
      }
    });
  }));

  vscode.commands.registerCommand('hsm.showVarHelpFile', (element) => {
    vscode.commands.executeCommand('vscode.open', vscode.Uri.parse('http://cam.autodesk.com/posts/reference/' + (element ? element.html.split('#')[0] : "")));
  });
  
  const functionSelectionProvider = new functionNodes.functionListProvider(context);
  vscode.window.registerTreeDataProvider('functionList', functionSelectionProvider);

  var disposable = vscode.commands.registerCommand('functionList.refreshEntry', () => {
    functionSelectionProvider.refresh();
  });
  context.subscriptions.push(disposable);

  context.subscriptions.push(vscode.commands.registerCommand('HSM.selectCNCFile', () => {
    checkDirSize(cncFilesLocation);
  }));

  disposable = vscode.commands.registerCommand('HSM.postProcess', () => {
    if (vscode.window.activeTextEditor.document.fileName.toUpperCase().indexOf(".CPS") >= 0) {
      postFile = vscode.window.activeTextEditor.document.fileName.toString();
    }
    if (path.extname(vscode.window.activeTextEditor.document.fileName) == ".cps") {
      if (!fs.existsSync(cncFile)) {
        checkDirSize(cncFilesLocation);
      } else {
        if (!postLoc) {
          try {
            if (fs.existsSync(settingsLocation)) {
              var lines = fs.readFileSync(settingsLocation);
              if (lines.length > 1) {
                var sett = JSON.parse(lines);
                if (sett.postLocation) postLoc = sett.postLocation;
              }
            } else {
              fs.writeFileSync(settingsLocation, "");
            }
          } catch (e) {
            vscode.window.showErrorMessage(e.toString());
          }
        }
        var postExists = true;
        if (postLoc) {

          if (!fs.existsSync(postLoc)) {
            locatePostEXE(true);
          }
        } else {
          locatePostEXE(true);
        }
        if (postExists) {
          if (cncFile) {
            if (fs.existsSync(cncFile)) {
              var tmpCNC = tmp + "\\" + path.basename(cncFile);
              if (!fs.existsSync(tmpCNC)) {
                copyF(cncFile);
              }


            }
          }
          var tmpPostFile = tmp + "\\" + path.basename(cncFile);
          postProcess(tmpPostFile, vscode.window.activeTextEditor.document.fileName);
        }
      }
    }
  });
  context.subscriptions.push(disposable);

  context.subscriptions.push(vscode.commands.registerCommand('functionList.revealRange', (editor, range) => {
    editor.revealRange(range, vscode.TextEditorRevealType.Default);
    editor.selection = new vscode.Selection(range.start, range.start);
    vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  }));

  disposable = vscode.commands.registerCommand('extension.startHSMPlugin', function() {

    if (vscode.window.activeTextEditor.document.fileName.toUpperCase().indexOf(".CPS") >= 0) {
      postFile = vscode.window.activeTextEditor.document.fileName.toString();
    } else {
      var items = ["Help"];
      var pickedItem = "";
      var opts = QuickPickOptions = {placeHolder: "Select the required command"};
      var g = vscode.window.showQuickPick(items, opts).then(val => {
        onPickedItem(val);
      });

      return;
    }
    try {
      if (fs.existsSync(settingsLocation)) {
        var lines = fs.readFileSync(settingsLocation);
        if (lines.length > 1) {
          var sett = JSON.parse(lines);
          if (sett.postLocation) postLoc = sett.postLocation;
        }
      } else {
        fs.writeFileSync(settingsLocation, "");
      }
    } catch (e) {
      vscode.window.showErrorMessage(e.toString());
    }
    var postExists = true;
    if (postLoc) {
      if (!fs.existsSync(postLoc)) {
        postExists = false
        locatePostEXE(true);
      }
    } else {
      locatePostEXE(true);
      postExists = false;
    }
    if (postExists) {
      if (cncFile) {
        if (fs.existsSync(cncFile)) {
          var tmpCNC = tmp + "/" + path.basename(cncFile);
          if (!fs.existsSync(tmpCNC)) {
            copyF(cncFile);
          }
        }
      }
      vscode.window.setStatusBarMessage("The Autodesk HSM post utility has been loaded", 10000);
      var items = ["Change CNC file", "Post process", "Help"];
      var pickedItem = "";
      var opts = QuickPickOptions = {placeHolder: "Select the required command"};
      var g = vscode.window.showQuickPick(items, opts).then(val => onPickedItem(val));
    }
  });
  context.subscriptions.push(disposable);
}

exports.activate = activate;
function setAutoComplete(active) {
  if ((vscode.window.visibleTextEditors.length <= 0) || (vscode.window.activeTextEditor == undefined)) {
    return;
  }
  if (vscode.window.activeTextEditor.document.fileName.toUpperCase().indexOf(".CPS") < 0) {
    return;
  }
  let firstLine = vscode.window.activeTextEditor.document.lineAt(0).text;
  if (active == "onLoad") {
    active = firstLine.toLowerCase().includes("\\\\language files\\\\globals.d.ts");
  }

  if (active) {
    var languageFileLocation = resLocation + "\\language files\\globals.d.ts";
    var partsOfPath = languageFileLocation.split('\\');
    languageFileLocation = partsOfPath.join('\\\\');
    let fullIncludeString = "/// <reference path=\"" + languageFileLocation + "\" />" + "\n";
    // first line already contains auto complete
    if (firstLine.toLowerCase().includes("\\\\language files\\\\globals.d.ts")) {
      vscode.window.activeTextEditor.edit(editBuilder => {editBuilder.replace(new vscode.Range(0, 0, 1, 0), fullIncludeString);});
    } else {
      vscode.window.activeTextEditor.edit(editBuilder => {editBuilder.insert(new vscode.Position(0, 0), fullIncludeString);});
    }
  } else if (firstLine.toLowerCase().includes("\\\\language files\\\\globals.d.ts")) {
      vscode.window.activeTextEditor.edit(editBuilder => {editBuilder.delete(new vscode.Range(0, 0, 1, 0));});
  }
}

// Show selected item in a message box
function SelectItem(element, reset) {
  if (element.label != undefined) {
    var string = element.label.toString().replace(/\s/g, "").split(":");
  } else {
    var string = element.toString().replace(/\s/g, "").split(":");
  }

  let cpsPath = getCpsPath();
  var hash = crypto.createHash('md5').update(cpsPath).digest('hex');
  var jsonPath = propertyJSONpath + hash + ".json";

  var lines = fs.readFileSync(jsonPath);
  if (lines.length > 1) {
    var obj = JSON.parse(lines);
  } else {
    vscode.window.showErrorMessage("Post processor properties json file not found!");
    return;
  }

  if (reset) {
    obj.changed.properties[string[0]] = obj.defaults.properties[string[0]];
    writeJSON(obj, jsonPath);
    // vscode.window.showInformationMessage("Reset of property '" + string[0] + "' was successful");
    vscode.window.setStatusBarMessage("Reset of property '" + string[0] + "' was successful", 5000);
    return;
  }

  var propertyIds = [];
  for (var key in obj.changed.properties) {
    if (obj.changed.hasOwnProperty('propertyDefinitions')) {
      if (key == string[0] && obj.changed.propertyDefinitions[key] != undefined) {
        if (obj.changed.propertyDefinitions[key].type == "enum") {
          for (var v in obj.changed.propertyDefinitions[key].values) {
            if (obj.changed.propertyDefinitions[key].values[v].id != undefined) {
              propertyIds.push(obj.changed.propertyDefinitions[key].values[v].id);
            } else {
              propertyIds.push(obj.changed.propertyDefinitions[key].values[v]);
            }
          }
        }
      }
    }
  }

  if ((string[1] == "false") || (string[1] == "true") || (propertyIds.length > 1)) {
    // if (isNaN(string[1]) || (propertyIds.length > 1)) {
    if (propertyIds.length > 1) {
      var items = propertyIds;
    } else {
      var items = ["true", "false"];
    }
    var opts = QuickPickOptions = {placeHolder: "'" + string[0] + "'" + " (current setting: '" + string[1] + "')"};
    vscode.window.showQuickPick(items, opts).then((selected) => {
      if (selected != undefined) {
        // vscode.window.showInformationMessage("Property '" + string[0] + "' successfully changed to '" + selected + "'");
        vscode.window.setStatusBarMessage("Property '" + string[0] + "' successfully changed to '" + selected + "'", 5000);
        if (propertyIds.length > 1) {
          obj.changed.properties[string[0]] = selected;
        } else {
          obj.changed.properties[string[0]] = JSON.parse(selected);
        }
        writeJSON(obj, jsonPath);
      }
    });
  } else { // use input box for values
    var options = {placeHolder: "Specify your value for the property here" + " (current value: '" + string[1] + "')"};
    vscode.window.showInputBox(options).then((input) => {
      if (input != undefined) {
        // vscode.window.showInformationMessage("Property '" + string[0] + "' successfully changed to '" + input + "'");
        vscode.window.setStatusBarMessage("Property '" + string[0] + "' successfully changed to '" + input + "'", 5000);
        obj.changed.properties[string[0]] = parseFloat(input);
        writeJSON(obj, jsonPath);
      }
    });
  }
}

function writeJSON(obj, jsonPath) {
  var JSONData = obj;
  var file = fs.createWriteStream(jsonPath);
  file.on('error', function(errors) {});
  file.write(JSON.stringify(JSONData));
  file.end(function() {
    wait(100);
    vscode.commands.executeCommand('propertyList.refreshPropertyList');
    config = vscode.workspace.getConfiguration("HSMPostUtility");
    var postOnPropertyChange = config.get("postOnPropertyChange");
    if (postOnPropertyChange) {
      vscode.commands.executeCommand('HSM.postProcess');
    }
  });
}

function checkForCPS() {
  if (vscode.window.activeTextEditor.document.isUntitled) return;
  var ogName = vscode.window.activeTextEditor.document.fileName;
  var newExtension = path.extname(ogName);
  if (newExtension.toLowerCase() == ".cps") {
    var workspaceDir = vscode.workspace.workspaceFolders;
    var newFile = tmp + "\\" + path.basename(ogName) + ".js";
    fs.createReadStream(ogName).pipe(fs.createWriteStream(newFile));
    tmpCPSFile.push([newFile.toLowerCase(), ogName.toLowerCase()]);
    var jsonPath = tmp + "\\jsconfig.json";
    var tsLib = tmp + "\\globals.d.ts";
    if (!fs.existsSync(jsonPath)) {
      fs.createReadStream(resLocation + "\\language files\\jsconfig.json").pipe(fs.createWriteStream(jsonPath));
    }
    if (!fs.existsSync(tsLib)) {
      fs.createReadStream(resLocation + "\\language files\\globals.d.ts").pipe(fs.createWriteStream(tsLib));
    }
    vscode.window.showTextDocument(vscode.workspace.openTextDocument(newFile), vscode.ViewColumn.One);
  }
}

function savedoc() {
  var savedDoc = vscode.window.activeTextEditor.document.fileName;
  if (!savedDoc.toLocaleLowerCase().includes("cps")) {
    return;
  }
  var isDebugOpen = false;
  for (var i = 0; i < vscode.window.visibleTextEditors.length; i++) {
    let visibleEditor = vscode.window.visibleTextEditors[i].document.fileName.toLowerCase()
    if (visibleEditor == outputpath.toLowerCase() || visibleEditor == logPath.toLowerCase() || visibleEditor == debugOutputpath.toLowerCase()) {
      isDebugOpen = true;
      if (vscode.window.visibleTextEditors[i].document.isDirty) {
        vscode.window.visibleTextEditors[i].document.save();
      }
    }
  }
  config = vscode.workspace.getConfiguration("HSMPostUtility");
  var postOnSave = config.get("postOnSave");

  if (isDebugOpen && postOnSave) {
    var tmpPostFile = tmp + "\\" + path.basename(cncFile);
    postProcess(tmpPostFile, savedDoc);
  }

}

function help() {
  var uri = vscode.Uri.file(resLocation + "\\help\\helpFile.html");
  vscode.commands.executeCommand('vscode.previewHtml', uri, vscode.ViewColumn.Two);
}

function showSetupSheet(lines, name) {
  var cDoc = vscode.window.activeTextEditor.document;
  var previewUri = vscode.Uri.parse('ncPreview://authority/assistant');
  var TextDocumentContentProvider = (function() {
    function TextDocumentContentProvider() {
      this._onDidChange = new vscode.EventEmitter();
    }

    TextDocumentContentProvider.prototype.provideTextDocumentContent = function(uri) {
      return this.createCodePreview();
    };

    Object.defineProperty(TextDocumentContentProvider.prototype, "onDidChange", {
      get: function() {
        return this._onDidChange.event;
      },
      enumerable: true,
      configurable: true
    });
    TextDocumentContentProvider.prototype.update = function(uri) {
      this._onDidChange.fire(uri);
    };

    TextDocumentContentProvider.prototype.createCodePreview = function() {
      return this.extractData();
    };

    TextDocumentContentProvider.prototype.extractData = function() {
      return lines;
    };
    TextDocumentContentProvider.prototype.errorSnippet = function(error) {
      return "\n                <body>\n                    " + error + "\n                </body>";
    };
    return TextDocumentContentProvider;
  }());

  var provider = new TextDocumentContentProvider();
  var registration = vscode.workspace.registerTextDocumentContentProvider('ncPreview', provider);
  vscode.commands.executeCommand('vscode.previewHtml', previewUri, vscode.ViewColumn.Two).then(function(success) {
    vscode.window.showTextDocument(cDoc);
  }, function(reason) {
    vscode.window.showErrorMessage(reason);
  });
}

function locatePostEXE(val) {
  if (val) {
    /** check to see if Fusion is installed. If it is, use the post EXE from there */
    let fusionDataFile = process.env.LOCALAPPDATA + "\\autodesk\\webdeploy\\production\\6a0c9611291d45bb9226980209917c3d\\FusionLauncher.exe.ini";
    if (fs.existsSync(fusionDataFile)) {
      var data = fs.readFileSync(fusionDataFile, "utf16le");
      let lines = data.split("\n");
      for (let j = 0; j < lines.length; ++j) {
        let activeLine = lines[j];
        if (activeLine.toLowerCase().includes("fusion360.exe")) {
          let fusionInstallLocation = activeLine.substring(8, activeLine.length - 16);
          fusionInstallLocation += "\\Applications\\CAM360\\post.exe";
          if (fs.existsSync(fusionInstallLocation)) {
            postLoc = fusionInstallLocation;
            var JSONData = {"postLocation": fusionInstallLocation};
            var file = fs.createWriteStream(settingsLocation);
            file.on('error', function(errors) {});
            file.write(JSON.stringify(JSONData));
            file.end();
            return;
          }
        }
      }
    } else {
      vscode.window.showErrorMessage("Post processor executable cannot be found. Please select your post executable location", "Browse...").then((val) => {
        if (val == "Browse...") {
          vscode.window.showOpenDialog({openFiles: true, filters: {}}).then(val => {
            var selectedPath = val[0].path.substr(1, val[0].path.length);
            if (fs.existsSync(selectedPath) && selectedPath.toLowerCase().includes("post")) {
              postLoc = selectedPath;
              var JSONData = {"postLocation": selectedPath};
              var file = fs.createWriteStream(settingsLocation);
              file.on('error', function(errors) {});
              file.write(JSON.stringify(JSONData));
              file.end();
              vscode.window.showInformationMessage("Post processor location updated correctly.")
            } else {
              vscode.window.showInformationMessage("The post EXE you selected is invalid or does not exist.");
            }
            return false;
          });
        }
      });
    }
  } else {
    vscode.window.showInformationMessage("Please select your post excutable", "Browse...").then((val) => {
      if (val == "Browse...") {
        vscode.window.showOpenDialog({openFiles: true, filters: {}}).then(val => {
          var selectedPath = val[0].path.substr(1, val[0].path.length);
          if (fs.existsSync(selectedPath) && selectedPath.toLowerCase().includes("post")) {
            postLoc = selectedPath;
            var JSONData = {"postLocation": selectedPath};
            var file = fs.createWriteStream(settingsLocation);
            file.on('error', function(errors) {});
            file.write(JSON.stringify(JSONData));
            file.end();
            vscode.window.showInformationMessage("Post processor location updated correctly.")
          } else {
            vscode.window.showInformationMessage("The post EXE you selected is invalid or does not exist.");
          }
          return false;
        });
      }
    });
  }
}

let secondClick = false;
let times = 2;
// this seems to get called twice for each event, which is messing things up. Added times mod 2 to only call it once
function handleChange(event) {
  if (vscode.window.activeTextEditor.document.fileName.includes("debuggedfile") && !vscode.window.activeTextEditor.document.fileName.includes(".log") && times % 2 == 0) {
    var selectedLine = vscode.window.activeTextEditor.selection.start.line;
    config = vscode.workspace.getConfiguration("HSMPostUtility");
    let needTwoClicks = config.get("twoClickLineJumping");
    if (selectedLine != lastSelectedLine) {
      amountToMove = 0;
      secondClick = false;
    }

    if (!secondClick && needTwoClicks) {
      secondClick = true;
      lastSelectedLine = selectedLine;
      return;
    }

     fs.readFile(debugOutputpath, function(err, data) {
      if (err) throw err;
      var array = data.toString().split('\n');
      var lineData = [];
      var lineToMoveTo = 0;
      var currentIndex = 0;
      var notNotes = true;
      var moved = false;
      for (var i = 0; i < array.length; i++) {
        // support for notes. These are not output on debug lines, so they must be skipped
        if (array[i].includes("!DEBUG")) {
          notNotes = true;
          if (array[i].includes("notes") || array[i].toUpperCase().includes("MATERIAL")) {
            notNotes = false;
          }
        }

        if (!array[i].includes("!DEBUG") && notNotes && !moved) {
          if (currentIndex == selectedLine) {
            if (selectedLine == lastSelectedLine) {
              try {
                lineToMoveTo = parseInt(lineData[lineData.length - (amountToMove + 1)].split(':')[2]);
                if (isNaN(lineToMoveTo)) {
                  amountToMove = 0;
                  lineToMoveTo = parseInt(lineData[lineData.length - (amountToMove + 1)].split(':')[2]);
                }
              } catch (e) {
                amountToMove = 0;
                lineToMoveTo = parseInt(lineData[lineData.length - (amountToMove + 1)].split(':')[2]);
              }
            }
            moveLine(lineToMoveTo);
            amountToMove = amountToMove + 1;
            moved = true;
          }
          currentIndex += 1;
        }
        lineData.push(array[i]);
      }
    });
    lastSelectedLine = selectedLine;
  }
  times += 1;
}

function checkForAutoComplete(event) {
  setAutoComplete("onLoad");
}

function onPickedItem(picked) {
  if (picked == "Post process") {
    if (!fs.existsSync(cncFile)) {
      checkDirSize(cncFilesLocation);
    } else {
      var tmpPostFile = tmp + "\\" + path.basename(cncFile);
      postProcess(tmpPostFile, vscode.window.activeTextEditor.document.fileName);
    }

  } else if (picked == "Change CNC file") {
    checkDirSize(cncFilesLocation);
  } else if (picked == "Intelligent Editing") {
    intelEdit();
  } else if (picked == "Help") {
    help();
  }
}

function intelEdit() {
  var tempDoc = tmp + "/" + path.basename(vscode.window.activeTextEditor.document.fileName.toString()) + ".js";
  fs.createReadStream(vscode.window.activeTextEditor.document.fileName.toString()).pipe(fs.createWriteStream(tempDoc));
  vscode.window.showTextDocument(vscode.workspace.openTextDocument(tempDoc), vscode.window.activeTextEditor.viewColumn);
}

function getDirectories(srcpath) {
  return fs.readdirSync(srcpath)
    .map(file => path.join(srcpath, file))
    .filter(path => fs.statSync(path).isDirectory());
}

function selectSub(dir) {
  var dirs = getDirectories(dir);
  var newList = [];
  for (var i = 0; i < dirs.length; i++) {
    var basename = dirs[i].replace(/\\/g, '/').replace(/.*\//, '');
    newList.push(basename);
  }
  newList.push("Browse...");
  var selection = vscode.window.showQuickPick(newList).then(val => {
    if (val == "Browse...") {
      vscode.window.showOpenDialog({openFiles: true, filters: {'CNC Files': ['cnc']}}).then(val => {
        var selectedPath = val[0].path.substr(1, val[0].path.length);
        cncFile = selectedPath;
      });
    } else {
      checkDirSize(dir + "\\" + val)
    }
  });
}

function checkDirSize(dir) {
  if (!dir) dir = resLocation + "\\CNC files";
  var dirs = getDirectories(dir);
  if (dirs.length > 0) {
    selectSub(dir);
  } else {
    selectCNCFile(dir);
  }
}

function selectCNCFile(p) {
  // create a quick pick for CNC files
  var lists = fs.readdirSync(p);
  ListItems = [];
  // ListItems = vscode.workspace.findFiles( '**/*.cnc', '**/node_modules/**', 10);
  for (var i = 0; i < lists.length; i++) {
    if (lists[i].toString().toUpperCase().includes(".CNC")) {
      ListItems.push(p + "\\" + lists[i].toString());
    }
  }

  var newList = [];
  for (var i = 0; i < ListItems.length; i++) {
    var basename = ListItems[i].replace(/\\/g, '/').replace(/.*\//, '');
    newList.push(basename);
  }
  var opts = QuickPickOptions = {placeHolder: "Select a the required CNC to post process"};
  var g = vscode.window.showQuickPick(newList).then(val => selectedCNCFile(val, ListItems));
}

function selectedCNCFile(picked, fullList) {
  var itemToUse = undefined;
  for (var i = 0; i < fullList.length; i++) {
    var basename = fullList[i].replace(/\\/g, '/').replace(/.*\//, '');
    if (picked == basename) {
      itemToUse = fullList[i];
    }
  }

  if (itemToUse) {
    cncFile = itemToUse;
  }

  vscode.commands.executeCommand('HSM.postProcess');
}

function selectUnits() {
  config = vscode.workspace.getConfiguration("HSMPostUtility");
  switch (config.get("outputUnits")) {
    case "MM":
      units = 1;
      break;
    case "IN":
      units = 0;  
      break;
    default:
      units = 1;
  }
}

function findErrorLine(log) {
  fs.readFile(log, function(err, data) {
    if (err) throw err;
    var array = data.toString().split('\n');

    for (var i = array.length - 1; i > 0; --i) {
      if (array[i].toUpperCase().includes("ERROR(") && array[i].includes("):") && array[i].toUpperCase().includes(".CPS:")) {
        // found the stack dum. error line is next
          let line = array[i];
          let errorLine = line.split(".cps:")[1].split("):")[0];
        moveLine(+errorLine);
        return;
      }
    }
  });
}

function postProcess(cnc, postLocation) {
  vscode.commands.executeCommand('notifications.clearAll'); 
  var child = require('child_process').execFile;
  var executablePath = postLoc;
  var parameters = [];
  var activeEdit = vscode.window.activeTextEditor;
  var currentLine = vscode.window.activeTextEditor.selection.start.line;

  if (vscode.window.activeTextEditor.document.fileName.toUpperCase().indexOf(".CPS") >= 0) {
    postFile = vscode.window.activeTextEditor.document.fileName.toString();
  }
  config = vscode.workspace.getConfiguration("HSMPostUtility");
  var shorten = config.get("shortenOutputCode");
  var lineLimit = config.get("shortenOutputLineLimit");
  selectUnits();
  if (showDebugOutput) {
    parameters = ["--noeditor", "--debugall", "--property", "unit", units.toString(), "--property", "programName", "1005", postLocation, cncFile, outputpath];
  } else if(shorten) {
    parameters = ["--noeditor", "--debugall", "--shorten", lineLimit, "--property", "unit", units.toString(), "--property", "programName", "1005", postLocation, cncFile, outputpath];
  } else {
    parameters = ["--noeditor", "--debugall", "--property", "unit", units.toString(), "--property", "programName", "1005", postLocation, cncFile, outputpath];
  }
  
  vscode.commands.executeCommand('propertyList.checkForDifferences');
  wait(100);

  var hash = crypto.createHash('md5').update(postFile).digest('hex');
  var jsonPath = propertyJSONpath + hash + ".json";
  if (fs.existsSync(jsonPath)) {
    var lines = fs.readFileSync(jsonPath);
    if (lines.length > 1) {
      var obj = JSON.parse(lines);
      if (obj.changed.properties) {
        for (x in obj.changed.properties) {
          if (typeof obj.changed.properties[x] == "string") {
            obj.changed.properties[x] = "'" + obj.changed.properties[x] + "'";
          }
          parameters.push("--property", x, obj.changed.properties[x]);
        }
      }
    }
  }
  var passed = false;
  var _timeout = config.get("timeoutForPostProcessing");
  _timeout *= 1000; // in seconds
  child(executablePath, parameters, {timeout:_timeout}, function(err, data) {
    if (err) {
      if (fs.existsSync(logPath)) {
        if (err.signal == "SIGTERM") {
          vscode.window.showErrorMessage("Post processing failed due to timeout.");
        } else {
          vscode.window.showInformationMessage("Post processing failed, see the log for details.");
        }
        vscode.window.showTextDocument(vscode.workspace.openTextDocument(logPath), vscode.ViewColumn.Two, true);
        findErrorLine(logPath);
      } else {
        vscode.window.showInformationMessage("Post processing failed");
      }
      return;
    }
    console.log(err)
    console.log(data.toString());
  
    if (fs.existsSync(outputpath)) { 
      let rapids = [];
      let linears = [];
      let circs = [];
      let other = [];
      if (!showDebugOutput) {
        fs.readFile(outputpath, function(err, data) {
          let lineAt = 0;
          let type = 0; // 0 = other, 1 = rapid, 2 = linear, 3 = circular
          var array = data.toString().split('\n');
          var lines = "";
          var lineData = "!DEBUG:" + postLocation + '\n';
          var writeOutput = true;
          for (var i = 0; i < array.length; i++) {
            if (array[i].includes("!DEBUG")) {
              if (array[i].toUpperCase().includes("ONRAPID")) {
                type = 1;
              } else if (array[i].toUpperCase().includes("ONLINEAR")) {
                type = 2;
              } else if (array[i].toUpperCase().includes("ONCIRCULAR")) {
                type = 3;
              }
            }
  
            if (!writeOutput && array[i].includes("!DEBUG")) {
              writeOutput = true;
            }
  
            if (array[i].includes("!DEBUG") && (array[i].includes("notes") || array[i].toUpperCase().includes("MATERIAL"))) {
              writeOutput = false;
            }
  
            if (!array[i].includes("!DEBUG") && writeOutput) {
              type = 0;
              lines = lines + array[i] + '\n';
            }
  
            let pos = new vscode.Range(new vscode.Position(i, 0), new vscode.Position(i + 1, 0));
            switch (type) {
              case 0:
                other.push(pos);
                break;
              case 1:
                rapids.push(pos);
                break;
              case 2:
                linears.push(pos);
                break;
              case 3:
                circs.push(pos);
                break;
            }
            lineData += array[i] + '\n';
  
          }
    

          wait(200);

          var file = fs.createWriteStream(outputpath);
          file.on('error', function(errors) {
          });
          file.write(lines);
          file.end(function(finished) {
            wait(300);
            let doc = vscode.window.showTextDocument(vscode.workspace.openTextDocument(outputpath), vscode.ViewColumn.Two, true);
          });
  
          file = fs.createWriteStream(debugOutputpath);
          file.on('error', function(errors) {
          });
          file.write(lineData);
          file.end();
        });
      } else {
        wait(500);
        fs.readFile(outputpath, function(err, data) {
          let output = data;
          var file = fs.createWriteStream(outputpath);
          file.on('error', function(errors) {
          });
          file.write(output);
          file.end(function(finished) {
            wait(300);
            let doc = vscode.window.showTextDocument(vscode.workspace.openTextDocument(outputpath), vscode.ViewColumn.Two, true);
          });
        });
      }
    }
  });
}

function wait(ms) {
  var start = new Date().getTime();
  var end = start;
  while (end < start + ms) {
    end = new Date().getTime();
  }
}

function moveLine(line) {
  var docFound = false;
  for (var i = 0; i < vscode.window.visibleTextEditors.length; i++) {
    var activeFile = vscode.window.visibleTextEditors[i];
    if (activeFile.document.fileName == postFile) {
      docFound = true;
      if (enableLineSelection) {
        vscode.window.visibleTextEditors[i].selection = new vscode.Selection(new vscode.Position(line - 1, 0), new vscode.Position(line - 1, 0));
        vscode.window.showTextDocument(vscode.window.visibleTextEditors[i].document, vscode.ViewColumn.One);
        vscode.window.visibleTextEditors[i].revealRange(vscode.window.visibleTextEditors[i].selection, vscode.TextEditorRevealType.InCenter);
      }
    }
  }

  if (!docFound) {
    if (!enableLineSelection) {
      vscode.window.showErrorMessage("The post processor (" + postFile + ") that created this output has been closed!");
    }
  }
}

function copyF(fileToCopy) {
  //set the path for the temporary post EXE
  var tmpPostFile = tmp + "/" + path.basename(fileToCopy);
  // if the post exe isn't in the temp directory, copy it
  if (!fs.existsSync(tmpPostFile)) {
    fs.createReadStream(fileToCopy).pipe(fs.createWriteStream(tmpPostFile));
  }
}

function copyFile(src, destination) {
  fs.createReadStream(src).pipe(fs.createWriteStream(destination));
}

function copyCNCFiles() {
  let loc = resLocation + "\\CNC files\\Custom";
  if (fs.existsSync(loc)) {
    let cncFiles = fs.readdirSync(loc);
    if (cncFiles.length > 0) {
      if (!fs.existsSync(customCNC)) {
        if (!fs.existsSync(tmp + "\\Autodesk")) {
          fs.mkdirSync(tmp + "\\Autodesk")
        }
        if (!fs.existsSync(tmp + "\\Autodesk\\VSCode")) {
          fs.mkdirSync(tmp + "\\Autodesk\\VSCode");
        }
        fs.mkdirSync(customCNC);
      }
    }
    for (var i = 0; i < cncFiles.length; ++i) {
      let activeCNC = loc + "\\" + cncFiles[i];
      if (fs.existsSync(activeCNC)) {
        let copyLocation = customCNC + "\\" + cncFiles[i];
        if (fs.existsSync(copyLocation)) {
          fs.unlinkSync(copyLocation);
        }
          copyFile(activeCNC, copyLocation);
      }
    }
  }
}

function getCpsPath() {
  let cpsPath;
  if (vscode.window.activeTextEditor.document.fileName.toUpperCase().indexOf(".CPS") >= 0) {
    cpsPath = vscode.window.activeTextEditor.document.fileName.toString();
  } else {
    vscode.window.showErrorMessage("The active file is not a post processor file.");
    return undefined;
  }
  return cpsPath;
}

function deactivate() {
  console.log("Thank you for using the HSM post development addin!");
}
exports.deactivate = deactivate;
