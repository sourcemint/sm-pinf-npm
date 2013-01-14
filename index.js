
const PATH = require("path");
const FS = require("fs");
const DEEPMERGE = require("deepmerge");
const JSONLINT = require("jsonlint");


exports.for = function(module) {
	return new PINF(module);
}


var PINF = function(module) {
	var self = this;

	var packagePath = PATH.dirname(module.filename);

	function loadJSON(path) {
		if (!PATH.existsSync(path)) return null;
		try {
			var json = FS.readFileSync(path).toString();
			// Replace environment variables.
			var m = json.match(/\$([A-Z0-9_]*)/g);
			if (m) {
				m.forEach(function(name) {
					json = json.replace(new RegExp("\\" + name, "g"), process.env[name.substring(1)] || name);
				});
			}
			return JSON.parse(json);
		} catch(err) {
			try {
				JSONLINT.parse(json);
			} catch(err) {
				err.message += " (while parsing '" + path + "')";
				throw err;
			}
			err.message += " (while parsing '" + path + "')";
			throw err;
		}
	}

	var programDescriptor = loadJSON(PATH.join(packagePath, "program.json"));

	if (typeof process.env.SM_WORKSPACE_HOME === "string") {
		var devProgramDescriptor = loadJSON(PATH.join(packagePath, "program.dev.json"));
		if (devProgramDescriptor) {
			programDescriptor = DEEPMERGE(programDescriptor, devProgramDescriptor);
		}
	}

	if (
		programDescriptor &&
		programDescriptor.config &&
		programDescriptor.config["."]
	) {
		module.config = programDescriptor.config["."];
	} else {
		module.config = {};
	}
}
