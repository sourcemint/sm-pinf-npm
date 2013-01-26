
const PATH = require("path");
const FS = require("fs");
const DEEPMERGE = require("deepmerge");
const JSONLINT = require("jsonlint");


exports.for = function(module) {
	return new PINF(module);
}


var PINF = function(module) {
	var self = this;

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

	function findDescriptor(packagePath, basename) {
		var descriptorPath = PATH.join(packagePath, basename);
		while (!PATH.existsSync(descriptorPath)) {
			var newPath = PATH.join(descriptorPath, "../..", PATH.basename(descriptorPath));
			if (newPath === descriptorPath) return false;
			descriptorPath = newPath;
			if (PATH.existsSync(descriptorPath)) {
				break;
			}
		}
		return descriptorPath;
	}

	module.config = {};

	// TODO: Use `module.parent` and `module.paths` to get config info instead of going up path
	//		 as path is incorrect when modules are symlinked.
	var packagePath = null;
	if (module.dirname) {
		packagePath = module.dirname;
	} else
	if (module.filename) {
		packagePath = PATH.dirname(module.filename);
	} else {
		throw new Error("Cannot determine package path.");
	}

	var packageDescriptorPath = findDescriptor(packagePath, "package.json");
	if (packageDescriptorPath) {
		var programDescriptorPath = findDescriptor(PATH.dirname(packageDescriptorPath), "program.json");
		var programDescriptor = loadJSON(programDescriptorPath);
		if (typeof process.env.SM_WORKSPACE_HOME === "string") {
			var devProgramDescriptor = loadJSON(PATH.join(programDescriptorPath, "..", "program.dev.json"));
			if (devProgramDescriptor) {
				programDescriptor = DEEPMERGE(programDescriptor, devProgramDescriptor);
			}
		}

		var ns = ".";
		if (module.ns && module.ns.config) {
			ns = module.ns.config;
		} else {
			// TODO: If config ns is not set derive it from package uid (package immediately containing module).
			//		 If package is where program descriptor is found, also look for ".".
		}

		if (
			programDescriptor &&
			programDescriptor.config &&
			programDescriptor.config[ns]
		) {
			module.config = programDescriptor.config[ns];
		}
	}
}
