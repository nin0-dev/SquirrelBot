import fs from "fs/promises";
import path from "path";
import { database } from ".";
import "../config";

async function migrate() {
	await database.query(`
		CREATE TABLE IF NOT EXISTS "migration_dirs" (
			"path" TEXT NOT NULL PRIMARY KEY,
			"last_run" INT NOT NULL
		)
	`);

	await process("migrations", true);
	await database.end();
}

async function process(dir: string, include_subdirs: boolean) {
	const files: string[] = [];
	const folders: string[] = [];

	for (const name of await fs.readdir(dir)) {
		const item_path = path.join(dir, name);

		if ((await fs.stat(item_path)).isDirectory()) {
			if (include_subdirs)
				folders.push(item_path);
		} else {
			const pattern = /^([0-9]+)-\w+\.sql$/;
			const matches = pattern.exec(name);
			if (!matches)
				continue;

			const index = Number(matches[1]);
			if (Number.isNaN(index))
				continue;

			files[index] = item_path;
		}
	}

	const last_run: number = (await database.query(
		`
			SELECT "last_run"
			FROM "migration_dirs"
			WHERE "path" = $1
		`,
		[dir]
	)).rows[0]?.last_run ?? -1;

	for (const [index, file] of files.entries()) {
		if (file === undefined)
			continue;

		if (index <= last_run) {
			console.log(`Skipping "${file}" as it has already been run`);
			continue;
		}

		console.log(`Running file "${file}"`);

		const sql = await fs.readFile(file, "utf-8");
		const client = await database.connect();

		let done = false;
		try {
			await client.query("BEGIN");

			await client.query(sql);
			await client.query(
				`
					INSERT INTO "migration_dirs" ("path", "last_run")
					VALUES ($1, $2)
					ON CONFLICT ("path") DO UPDATE
					SET "last_run" = $2
				`,
				[dir, index]
			);

			await client.query("COMMIT");
			done = true;
		} finally {
			if (!done)
				await client.query("ROLLBACK");

			client.release();
		}
	}

	if (include_subdirs)
		for (const subdir of folders)
			await process(subdir, false);
}

migrate();
