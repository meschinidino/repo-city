// Extraction JSON as served by GET /api/extraction (server schema
// version 1). Islands are districts, files are buildings typed by
// role, bridges are counted import edges between islands.

export interface ExtractionIsland {
  id: string;
  name: string;
  path: string;
  file_count: number;
  files: string[];
}

export interface ExtractionFile {
  path: string;
  island_id: string;
  roles: string[];
  building: string;
  import_count: number;
  importer_count: number;
}

export interface ExtractionBridge {
  from_island: string;
  to_island: string;
  count: number;
}

export interface Extraction {
  schema_version: number;
  is_stand_in_fixture: boolean;
  repo_root: string;
  counts: {
    files_parsed: number;
    files_with_parse_errors: number;
    total_imports: number;
    resolved_imports: number;
    unresolved_imports: number;
  };
  islands: ExtractionIsland[];
  files: ExtractionFile[];
  bridges: ExtractionBridge[];
}
