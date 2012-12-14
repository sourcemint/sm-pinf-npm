
const PATH = require("path");
const FS = require("fs");


exports.for = function(module) {
	return new PINF(module);
}


var PINF = function(module) {
	var self = this;

	var packagePath = PATH.dirname(module.filename);

	function loadJSON(path) {
		if (!PATH.existsSync(path)) return null;
		try {
			return JSON.parse(FS.readFileSync(path));
		} catch(err) {
			err.message += " (while parsing '" + packagePath + "')";
			throw err;
		}
	}

	var programDescriptor = loadJSON(PATH.join(packagePath, "program.json"));
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
