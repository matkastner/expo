import spawnAsync from '@expo/spawn-async';
import assert from 'assert';
import chalk from 'chalk';
import fs from 'fs-extra';
import glob from 'glob-promise';
import path from 'path';

import { ANDROID_DIR } from '../../Constants';
import logger from '../../Logger';
import { copyFileWithTransformsAsync, transformFileAsync } from '../../Transforms';
import { FileTransforms } from '../../Transforms.types';
import { searchFilesAsync } from '../../Utils';
import {
  exponentPackageTransforms,
  vendoredModulesTransforms,
} from './transforms/vendoredModulesTransforms';

const ANDROID_VENDORED_DIR = path.join(ANDROID_DIR, 'vendored');

/**
 * Versions Android vendored modules.
 */
export async function versionVendoredModulesAsync(
  sdkNumber: number,
  filterModules: string[] | null
): Promise<void> {
  const prefix = `abi${sdkNumber}_0_0`;
  const config = vendoredModulesTransforms(prefix);
  const baseTransforms = await baseTransformsFactoryAsync(prefix);
  const unversionedDir = path.join(ANDROID_VENDORED_DIR, 'unversioned');
  const versionedDir = vendoredDirectoryForSDK(sdkNumber);
  let vendoredModuleNames = await getVendoredModuleNamesAsync(unversionedDir);
  if (filterModules) {
    vendoredModuleNames = vendoredModuleNames.filter((name) => filterModules.includes(name));
  }

  for (const name of vendoredModuleNames) {
    logger.info('🔃 Versioning vendored module %s', chalk.green(name));

    const moduleConfig = config[name];
    const sourceDirectory = path.join(unversionedDir, name);
    const targetDirectory = path.join(versionedDir, name);
    const files = await searchFilesAsync(sourceDirectory, '**');

    await fs.remove(targetDirectory);

    for (const sourceFile of files) {
      await copyFileWithTransformsAsync({
        sourceFile,
        sourceDirectory,
        targetDirectory,
        transforms: {
          path: [...baseTransforms.path, ...(moduleConfig?.path ?? [])],
          content: [...baseTransforms.content, ...(moduleConfig?.content ?? [])],
        },
      });
    }

    await maybePrebuildSharedLibsAsync(name, sdkNumber);
    await transformExponentPackageAsync(name, prefix);
  }
}

/**
 * Prebuild shared libraries to jniLibs and cleanup CMakeLists.txt
 */
async function maybePrebuildSharedLibsAsync(module: string, sdkNumber: number) {
  const moduleRootDir = path.join(ANDROID_DIR, 'vendored', `sdk${sdkNumber}`, module, 'android');
  const cmakeFile = path.join(moduleRootDir, 'CMakeLists.txt');
  if (!fs.existsSync(cmakeFile)) {
    return;
  }

  logger.info('   Prebuilding shared libraries for %s', module);
  const gradleProject = module.replace(/\//g, '_');
  await spawnAsync(
    './gradlew',
    [`:vendored_sdk${sdkNumber}_${gradleProject}:copyReleaseJniLibsProjectAndLocalJars`],
    {
      cwd: ANDROID_DIR,
      // Uncomment the following line for verbose building output
      // stdio: 'inherit',
    }
  );

  const jniLibDir = path.join(moduleRootDir, 'src', 'main', 'jniLibs');
  const buildLibDir = path.join(
    moduleRootDir,
    'build',
    'intermediates',
    'stripped_native_libs',
    'release',
    'out',
    'lib'
  );
  const libFiles = await glob('**/*.so', {
    cwd: buildLibDir,
  });
  assert(libFiles.length > 0);
  await Promise.all(
    libFiles.map(async (file) => {
      const srcPath = path.join(buildLibDir, file);
      const archName = path.basename(path.dirname(file));
      const dstPath = path.join(jniLibDir, archName, path.basename(file));
      await fs.ensureDir(path.dirname(dstPath));
      await fs.copy(srcPath, dstPath);
    })
  );

  // Truncate CMakeLists.txt and not to build this cxx module when building versioned Expo Go
  await fs.writeFile(cmakeFile, '');
  await fs.remove(path.join(moduleRootDir, 'build'));
}

/**
 * Transform ExponentPackage.kt, e.g. add import abi prefix
 */
async function transformExponentPackageAsync(name: string, prefix: string) {
  const transforms = exponentPackageTransforms(prefix)[name] ?? null;
  const exponentPackageFile = path.resolve(
    path.join(
      ANDROID_DIR,
      `versioned-abis/expoview-${prefix}/src/main/java/${prefix}/host/exp/exponent/ExponentPackage.kt`
    )
  );
  await transformFileAsync(exponentPackageFile, transforms);
}

/**
 * Gets the library name of each vendored module in a specific directory.
 */
async function getVendoredModuleNamesAsync(directory: string): Promise<string[]> {
  const vendoredGradlePaths = await glob(`**/build.gradle`, {
    cwd: directory,
    nodir: true,
    realpath: true,
  });

  const gradlePattern = new RegExp(`${directory}/(.*)/android/build.gradle`, 'i');

  return vendoredGradlePaths.reduce((result, gradlePath) => {
    const moduleName = gradlePath.match(gradlePattern);
    if (moduleName) {
      result.push(moduleName[1]);
    }
    return result;
  }, [] as string[]);
}

/**
 * Removes the directory with vendored modules for given SDK number.
 */
export async function removeVersionedVendoredModulesAsync(sdkNumber: number): Promise<void> {
  const versionedDir = vendoredDirectoryForSDK(sdkNumber);
  await fs.remove(versionedDir);
}

/**
 * Get the gradle dependency version from `android/expoview/build.gradle`
 */
async function getGradleDependencyVersionFromExpoViewAsync(
  group: string,
  name: string
): Promise<string | null> {
  const expoviewGradleFile = path.join(ANDROID_DIR, 'expoview', 'build.gradle');
  const content = await fs.readFile(expoviewGradleFile, 'utf-8');
  const searchPattern = new RegExp(
    `\\b(api|implementation)[\\s(]['"]${group}:${name}:(.+?)['"]`,
    'g'
  );
  const result = searchPattern.exec(content);
  if (!result) {
    return null;
  }
  return result[2];
}

/**
 * Generates base transforms to apply for all vendored modules.
 */
async function baseTransformsFactoryAsync(prefix: string): Promise<Required<FileTransforms>> {
  const fbjniVersion = await getGradleDependencyVersionFromExpoViewAsync(
    'com.facebook.fbjni',
    'fbjni-java-only'
  );
  const proguardAnnotationVersion = await getGradleDependencyVersionFromExpoViewAsync(
    'com.facebook.yoga',
    'proguard-annotations'
  );

  return {
    path: [
      {
        // For package renaming, src/main/java/* -> src/main/java/abiN/*
        find: /\/(java|kotlin)\//,
        replaceWith: `/$1/${prefix}/`,
      },
    ],
    content: [
      {
        paths: '*.{java,kt}',
        find: /(^package\s+)([\w.]+;?)/m,
        replaceWith: `$1${prefix}.$2`,
      },
      {
        paths: '*.{java,kt}',
        find: /(\bcom\.facebook\.(catalyst|csslayout|fbreact|hermes|perftest|quicklog|react|systrace|yoga|debug)\b)/g,
        replaceWith: `${prefix}.$1`,
      },
      {
        paths: '*.{java,kt}',
        find: /\b((System|SoLoader)\.loadLibrary\("[^"]*)("\);?)/g,
        replaceWith: `$1_${prefix}$3`,
      },
      {
        paths: '*.{h,cpp}',
        find: /(\bkJavaDescriptor\s*=\s*\n?\s*"L)/gm,
        replaceWith: `$1${prefix}/`,
      },
      {
        paths: 'build.gradle',
        find: /\b(compileOnly|implementation)\s+['"]com.facebook.react:react-native:.+['"]/gm,
        replaceWith:
          `implementation 'host.exp:reactandroid-${prefix}:1.0.0'` +
          '\n' +
          // Adding some compile time common dependencies where the versioned react-native AAR doesn't expose
          `    compileOnly 'com.facebook.fbjni:fbjni:${fbjniVersion}'\n` +
          `    compileOnly 'com.facebook.yoga:proguard-annotations:${proguardAnnotationVersion}'\n` +
          `    compileOnly 'androidx.annotation:annotation:+'\n`,
      },
      {
        paths: 'build.gradle',
        find: 'buildDir/react-native-0*/jni',
        replaceWith: 'buildDir/reactandroid-abi*/jni',
      },
      {
        paths: ['build.gradle', 'CMakeLists.txt'],
        find: /\/react-native\//g,
        replaceWith: '/versioned-react-native/',
      },
      {
        paths: 'build.gradle',
        find: /def rnAAR = fileTree.*\*\.aar.*\)/g,
        replaceWith: `def rnAAR = fileTree("\${rootDir}/versioned-abis").matching({ include "**/reactandroid-${prefix}/**/*.aar" })`,
      },
      {
        paths: 'build.gradle',
        find: /def rnAAR = fileTree.*rnAarMatcher.*\)/g,
        replaceWith: `def rnAAR = fileTree("\${rootDir}/versioned-abis").matching({ include "**/reactandroid-${prefix}/**/*.aar" })`,
      },
      {
        paths: 'CMakeLists.txt',
        find: /(^set\s*\(PACKAGE_NAME\s*['"])(\w+)(['"]\))/gm,
        replaceWith: `$1$2_${prefix}$3`,
      },
      {
        paths: 'CMakeLists.txt',
        find: /(\bfind_library\(\n?\s*[A-Z_]+\n?\s*)(\w+)/gm,
        replaceWith(substring, group1, libName) {
          if (['fbjni', 'log'].includes(libName)) {
            return substring;
          }
          return `${group1}${libName}_${prefix}`;
        },
      },
      {
        paths: 'AndroidManifest.xml',
        find: /(\bpackage=")([\w.]+)(")/,
        replaceWith: `$1${prefix}.$2$3`,
      },
    ],
  };
}

/**
 * Returns the vendored directory for given SDK number.
 */
function vendoredDirectoryForSDK(sdkNumber: number): string {
  return path.join(ANDROID_VENDORED_DIR, `sdk${sdkNumber}`);
}
