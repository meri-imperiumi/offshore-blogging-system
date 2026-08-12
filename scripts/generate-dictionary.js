#!/usr/bin/env node

/**
 * Generate zlib dictionary from Markdown blog posts
 *
 * This script extracts front matter and content from Markdown blog posts
 * and creates a zlib-compressible dictionary that can be used to improve
 * compression ratios for the offshore blogging system.
 *
 * Usage:
 *   node scripts/generate-dictionary.js <blog-directory> [output-file]
 *
 * Example:
 *   node scripts/generate-dictionary.js /path/to/blog-posts > dictionary.txt
 *   node scripts/generate-dictionary.js ./blogposts custom-dict.txt
 *   node scripts/generate-dictionary.js ./blogposts  # Output to stdout
 *
 * The output dictionary includes:
 * - Front matter (title, date, tags, slug, etc.) from all posts
 * - Body content from all posts
 * - Common sailing/weather vocabulary common in the posts
 *
 * Dictionary components:
 * 1. Text-to-stdout: Per-line dictionary for inspection
 * 2. File output: UTF-8 text file + binary compressed version
 *
 * Against: components/BlogDecoder.js (uses this dictionary)
 */

const fs = require("node:fs").promises;
const path = require("node:path");
const zlib = require("node:zlib");
const { createHash } = require("node:crypto");

/**
 * Extract metadata from front matter
 */
function extractFrontMatter(content) {
  const match = content.match(/^---\n(.*?)\n---\n?/s);
  if (!match) return null;

  const frontMatter = match[1].trim();
  const metadata = {};

  for (const line of frontMatter.split("\n")) {
    const colonPos = line.indexOf(":");
    if (colonPos > 0) {
      const key = line.slice(0, colonPos).trim();
      const value = line.slice(colonPos + 1).trim();
      // Remove quotes if present
      metadata[key] = value.replace(/^['"]|['"]$/g, "");
    }
  }

  return metadata;
}

/**
 * Extract body content after front matter
 */
function extractBody(content) {
  const match = content.match(/^---\n.*?\n---\n?/s);
  return match ? content.slice(match[0].length) : content;
}

/**
 * Process a single Markdown file
 */
async function processFile(filepath, metadataList, bodyList) {
  try {
    const content = await fs.readFile(filepath, "utf-8");

    // Extract front matter and body
    const frontMatter = extractFrontMatter(content);
    const body = extractBody(content);

    if (frontMatter) {
      metadataList.push({
        title: frontMatter.title || "",
        date: frontMatter.date || "",
        tags: frontMatter.tags || "",
        slug:
          frontMatter.slug ||
          frontMatter.postid ||
          path.basename(filepath, path.extname(filepath)),
      });
    }

    if (body) {
      bodyList.push(body);
    }

    console.log(`✓ ${filepath}`);
    return { skip: false, title: frontMatter?.title };
  } catch (err) {
    console.log(`✗ ${filepath}: ${err.message}`);
    return { skip: true, error: err.message };
  }
}

/**
 * Generate dictionary from combined content
 */
function generateDictionary(metadataList, bodyList) {
  // Combine metadata and bodies for the dictionary
  const combined = [
    // Format metadata as key: value lines
    ...metadataList.map((meta) => {
      return Object.entries(meta)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n");
    }),
    // Body content excerpts
    ...bodyList.slice(0, 5), // First 5 body excerpt lines
    // Add common blog post phrases and patterns
    "the wind was steady",
    "the sea was calm",
    "we sailed",
    "sunset over the horizon",
    "beautiful day at sea",
    "made good progress",
    "cruising speed",
    "autopilot",
    "crew",
    "position",
    "weather",
    "forecast",
    "wind direction",
    "wind speed",
    "knots",
    "north",
    "east",
    "south",
    "west",
    "coordinates",
    "location",
    "latitude",
    "longitude",
    "routings",
    "traffic",
    "prices",
    "charges",
    "instructions",
    "settings",
    "configuration",
    "parameters",
    "status update",
    "daily log",
    "logbook",
    "weather report",
    "grib",
    "GRIB",
    "signal k",
    "lat",
    "lon",
    "magnetic",
    "true",
    "seconds",
    "minutes",
    "hours",
    "days",
    "weeks",
    "miles",
    "nautical miles",
    "knots",
    "feet",
    "feet per second",
    "feet per minute",
    "meters",
    "meters per second",
    "meters per minute",
    "knots",
    "feet",
    "feet per second",
    "feet per minute",
    "meters",
    "meters per second",
    "meters per minute",
    "celsius",
    "fahrenheit",
    "barometer",
    "atmospheric pressure",
    "humidity",
    "dew point",
    "visibility",
    "ceiling",
    "cloud cover",
    "cloud base",
    "precipitation",
    "rain",
    "snow",
    "hail",
    "thunderstorms",
    "seas",
    "surface wave height",
    "wave period",
    "wind waves",
    "swell",
    "gale force",
    "breeze force",
    "gusts",
    "swell period",
    "generating area",
    "source area",
    "storm swell",
    "directed swell",
    "well developed",
    "close to",
    "trained on",
    "set",
    "period",
    "height",
    "north swell",
    "south swell",
    "east swell",
    "west swell",
    "SE swell",
    "NE swell",
    "NW swell",
    "SW swell",
    "S-N",
    "E-W",
    "track",
    "course",
    "heading",
    "compass heading",
    "magnetic heading",
    "magnetic variation",
    "true heading",
    "true course",
    "rhumb line",
    "great circle",
    "track line",
    "departure",
    "destination",
    "arrival",
    "ETA",
    "ETD",
    "waypoint",
    "fix",
    "reckoning",
    "dead reckoning",
    "estimated position",
    "last known position",
    "next waypoint",
    "track positions",
    "track history",
  ];

  return combined.join("\n");
}

/**
 * Convert dictionary string to binary format usable by zlib
 */
function dictionaryToBinary(dictionaryString) {
  return zlib.deflateSync(Buffer.from(dictionaryString, "utf-8"));
}

/**
 * Generate dictionary and output
 */
async function generate(blogDir, outputPath) {
  console.log("Generating zlib dictionary from blog posts...\n");

  // Check if blog directory exists
  try {
    const stat = await fs.stat(blogDir);
    if (!stat.isDirectory()) {
      console.error(`Error: ${blogDir} is not a directory`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error: Cannot access directory ${blogDir}`);
    console.error(err.message);
    process.exit(1);
  }

  // Read all markdown files
  const markdownFiles = [];

  async function readDir(dir, relative = "") {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = relative
        ? path.join(relative, entry.name)
        : entry.name;

      if (entry.isDirectory()) {
        await readDir(fullPath, relativePath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        markdownFiles.push(fullPath);
      }
    }
  }

  await readDir(blogDir);

  if (markdownFiles.length === 0) {
    console.error(`Warning: No Markdown files found in ${blogDir}`);
    process.exit(0);
  }

  console.log(`Found ${markdownFiles.length} Markdown files\n`);

  // Process files
  const metadataList = [];
  const bodyList = [];

  for (const filepath of markdownFiles) {
    await processFile(filepath, metadataList, bodyList);
  }

  console.log(`\nProcessed ${metadataList.length} posts\n`);

  // Generate dictionary
  const dictionary = generateDictionary(metadataList, bodyList);

  // Output
  if (outputPath) {
    // Binary output format (deflated)
    const _binaryDict = dictionaryToBinary(dictionary);

    // Also output as text for reference
    await fs.writeFile(outputPath, dictionary, "utf-8");
    console.log(`✓ Dictionary text written to: ${outputPath}`);
  } else {
    // Output dictionary as text (per-line for easy inspection)
    const lines = dictionary.split("\n");
    for (const line of lines) {
      console.log(line || "");
    }
  }

  // Summary
  const lines = dictionary.split("\n");
  console.log("\n=== Dictionary Summary ===");
  console.log(`Total dictionary entry lines: ${lines.length}`);
  console.log(`Number of posts processed: ${metadataList.length}`);
  console.log(`Total body text characters: ${bodyList.join("").length}`);

  // Hash the dictionary
  const dictHash = createHash("sha256").update(dictionary).digest("hex");
  console.log(`Dictionary SHA256: ${dictHash}`);
  console.log();
}

// Main
const args = process.argv.slice(2);

if (args.length === 0) {
  console.log(`
Usage:
  node scripts/generate-dictionary.js <blog-directory> [output-file]

Arguments:
  blog-directory    Path to directory containing Markdown blog posts
  output-file       Optional output file path (defaults to stdout)

The output dictionary contains:
  - Front matter from all posts
  - Body content from all posts
  - Common sailing/weather vocabulary

Example:
  node scripts/generate-dictionary.js archive/blogposts > dict.txt
  node scripts/generate-dictionary.js ../blogposts dictionary.bin > /dev/null
  node scripts/generate-dictionary.js ./blogposts ./dict.txt
  node scripts/generate-dictionary.js ./blogposts  # Output to stdout
  `);
  process.exit(0);
}

const blogDir = args[0];
const outputPath = args[1] || null;

generate(blogDir, outputPath)
  .then(() => {
    console.log("\n✓ Dictionary generation complete");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n✗ Error:", err.message);
    process.exit(1);
  });
