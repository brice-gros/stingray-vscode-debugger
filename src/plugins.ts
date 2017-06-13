import {findFiles} from './helpers';
import SJSON = require('simplified-json');
import {readFileSync as readFile, existsSync as fileExists} from 'fs';
import * as path from 'path';

export interface Extension {

}

export interface ResourceExtension extends Extension {
    name: string;
    dir: string;
    path: string;
}

export interface Plugin {
    $path: string;
    $dir: string;
    extensions: {[extensionType: string]: Extension[]};
}

export function findPlugins (root: string) {
    let pluginDescriptorPaths = findFiles(root, ".stingray_plugin", true);
    return pluginDescriptorPaths.map(pluginDescriptorPath => {
        let pluginContent = readFile(pluginDescriptorPath, 'utf8');
        let plugin: Plugin = SJSON.parse(pluginContent);
        plugin.$path = pluginDescriptorPath;
        plugin.$dir = path.dirname(pluginDescriptorPath);
        return plugin;
    });
}

export function findResourceMaps (rootPluginPaths: string[]) {
    let resources:ResourceExtension[] = [];
    for (let rootPluginPath of rootPluginPaths) {
        let plugins = findPlugins(rootPluginPath);
        for (let plugin of plugins) {
            // Check for resource extensions
            if (plugin.extensions && plugin.extensions.resources && plugin.extensions.resources.length) {
                resources = resources.concat((<ResourceExtension[]>plugin.extensions.resources).map(res => {
                    return {
                        name: path.basename(res.path),
                        dir: plugin.$dir,
                        path: path.join(plugin.$dir, res.path)
                    }
                }));
            }
        }
    }
    return resources;
}
