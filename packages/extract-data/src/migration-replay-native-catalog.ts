/** Fixed PostgreSQL Source-derived model data. No SQL or native library is loaded.
 * PostgreSQL license; source locations/hashes and exported declarations only, no implementation copied. */
export const STOCK_PG17_CATALOG = {
  "format": 1,
  "model": "postgresql-17.12-stock-source-local-v1",
  "archiveSHA256": "9cf136a703d8ee2f83465c43be4e9e8e7930c82b0bfba13be7e2537be769ac55",
  "wholeModuleInventorySHA256": "7110c11e0a37115e6f65ae0930b5cdf92557399b1ef67c51a2da73991cf22f1c",
  "coreSource": [
    {
      "path": "src/backend/catalog/pg_type.c",
      "bytes": 32626,
      "sha256": "752c514f6d9af8032f28a9ebd096dbe455dab385e1ec8756dbcbc8b178702df3"
    },
    {
      "path": "src/backend/commands/extension.c",
      "bytes": 111438,
      "sha256": "289fef3a8a8c9532d1435b38214acb682a0ba4d155ff51e979b2463c8a5ea6fd"
    },
    {
      "path": "src/include/catalog/pg_type.h",
      "bytes": 14516,
      "sha256": "41f3027163983013a48d382bd3e108e5a9f5a4f9321354a24e6b212b3285e10c"
    }
  ],
  "premises": [
    "positively parsed group config major17; canonical17.12 is model choice, not deployed minor",
    "empty ordered Source-local extension membership; external preinstalled/added members excluded",
    "fixed stock native initialization and native operator semantics, not arbitrary C admission",
    "omitted schema has all-schema negative exposure, not public or API search_path",
    "only the five exact default routes; no update/drop/CASCADE/member mutation",
    "validation expressions use only typed native builtins with no source shadow",
    "possible abort conditions qualify later Source examination by live continuation"
  ],
  "rules": {
    "extensionGrammar": "source-local-create-relocate-v1",
    "types": "base-and-conservative-generated-array-negative-v1",
    "control": "typed-jsonb-text-array-and-ordinary-exists-abort-v1",
    "certificate": 2
  },
  "extensions": [
    {
      "name": "pgcrypto",
      "defaultVersion": "1.3",
      "requires": [],
      "relocatable": true,
      "fixedSchema": null,
      "control": {
        "path": "contrib/pgcrypto/pgcrypto.control",
        "bytes": 152,
        "sha256": "2a6c81eef34ae6cee9ff5b557f3b6285db7fdd7bc76ee57798e82c945c61c939"
      },
      "dispatch": {
        "path": "contrib/pgcrypto/Makefile",
        "bytes": 1593,
        "sha256": "e9bc0cdfff65a4f44e7504e50ab5055447a6c33cf418891a680c07688441142d"
      },
      "route": [
        {
          "path": "contrib/pgcrypto/pgcrypto--1.3.sql",
          "bytes": 5708,
          "sha256": "84f8eee1d6b03982fac596988b46bf89d5d5d8790d3133783eedad38bc7d8d38"
        }
      ],
      "moduleSourceDigest": "da77c046cd18cc497246426c13c9230124ec569265caec9abdf252b575f9a99c",
      "routines": [
        "armor",
        "crypt",
        "dearmor",
        "decrypt",
        "decrypt_iv",
        "digest",
        "encrypt",
        "encrypt_iv",
        "gen_random_bytes",
        "gen_random_uuid",
        "gen_salt",
        "hmac",
        "pgp_armor_headers",
        "pgp_key_id",
        "pgp_pub_decrypt",
        "pgp_pub_decrypt_bytea",
        "pgp_pub_encrypt",
        "pgp_pub_encrypt_bytea",
        "pgp_sym_decrypt",
        "pgp_sym_decrypt_bytea",
        "pgp_sym_encrypt",
        "pgp_sym_encrypt_bytea"
      ],
      "baseTypes": [],
      "nonrelationExports": {
        "aggregates": [],
        "operatorClasses": [],
        "operatorFamilies": "implicit families of the audited classes; not indexes",
        "casts": 0,
        "operators": []
      },
      "directRelations": [],
      "directColumns": []
    },
    {
      "name": "uuid-ossp",
      "defaultVersion": "1.1",
      "requires": [],
      "relocatable": true,
      "fixedSchema": null,
      "control": {
        "path": "contrib/uuid-ossp/uuid-ossp.control",
        "bytes": 178,
        "sha256": "eaafef3ac3fbaa16e59986201e15f2944abb841167fb37553700c11b6ba97e5b"
      },
      "dispatch": {
        "path": "contrib/uuid-ossp/Makefile",
        "bytes": 497,
        "sha256": "5aa95a54a16e8f367fe91a53eb658829c881279f1b08fff7fddc3043b208816d"
      },
      "route": [
        {
          "path": "contrib/uuid-ossp/uuid-ossp--1.1.sql",
          "bytes": 1516,
          "sha256": "1cf94e2eaa2033f32b80b1a7a371809d6cacc108b39d187c254f6fe04b383f84"
        }
      ],
      "moduleSourceDigest": "e9280aa4070b1e7b75a29813821dc9b87c66f1f1b3e9b573b9b9a79ac90363d9",
      "routines": [
        "uuid_generate_v1",
        "uuid_generate_v1mc",
        "uuid_generate_v3",
        "uuid_generate_v4",
        "uuid_generate_v5",
        "uuid_nil",
        "uuid_ns_dns",
        "uuid_ns_oid",
        "uuid_ns_url",
        "uuid_ns_x500"
      ],
      "baseTypes": [],
      "nonrelationExports": {
        "aggregates": [],
        "operatorClasses": [],
        "operatorFamilies": "implicit families of the audited classes; not indexes",
        "casts": 0,
        "operators": []
      },
      "directRelations": [],
      "directColumns": []
    },
    {
      "name": "citext",
      "defaultVersion": "1.6",
      "requires": [],
      "relocatable": true,
      "fixedSchema": null,
      "control": {
        "path": "contrib/citext/citext.control",
        "bytes": 173,
        "sha256": "748d123583d37e9f1be4376b736579b2e248750ddaa12a7bae1f8bc115ce43b5"
      },
      "dispatch": {
        "path": "contrib/citext/Makefile",
        "bytes": 582,
        "sha256": "efaff764f9cc5bdd3b3723deffb6816e1fbe1cacc4ee52e6ed65b863eaee1f83"
      },
      "route": [
        {
          "path": "contrib/citext/citext--1.4.sql",
          "bytes": 13466,
          "sha256": "ca0e42530cef4281e9ee788739c6774cf4d5e1ce8eeb1a84964150a9659d3e0b"
        },
        {
          "path": "contrib/citext/citext--1.4--1.5.sql",
          "bytes": 2284,
          "sha256": "8104223ef4f55afc26bddbca5a6f5500a87c026a9692c6bf1f06e2594fe69c21"
        },
        {
          "path": "contrib/citext/citext--1.5--1.6.sql",
          "bytes": 427,
          "sha256": "31917f922dcc33b58c34cd9f221d4822eadfd5a190f2d3f0a447e03f46de394e"
        }
      ],
      "moduleSourceDigest": "36d94000b54a094e865258ddde31e04e48d12335d2494269816e38694b786adc",
      "routines": [
        "citext",
        "citext_cmp",
        "citext_eq",
        "citext_ge",
        "citext_gt",
        "citext_hash",
        "citext_hash_extended",
        "citext_larger",
        "citext_le",
        "citext_lt",
        "citext_ne",
        "citext_pattern_cmp",
        "citext_pattern_ge",
        "citext_pattern_gt",
        "citext_pattern_le",
        "citext_pattern_lt",
        "citext_smaller",
        "citextin",
        "citextout",
        "citextrecv",
        "citextsend",
        "max",
        "min",
        "regexp_match",
        "regexp_matches",
        "regexp_replace",
        "regexp_split_to_array",
        "regexp_split_to_table",
        "replace",
        "split_part",
        "strpos",
        "texticlike",
        "texticnlike",
        "texticregexeq",
        "texticregexne",
        "translate"
      ],
      "baseTypes": [
        "citext"
      ],
      "nonrelationExports": {
        "aggregates": [
          "max",
          "min"
        ],
        "operatorClasses": [
          "citext_ops",
          "citext_pattern_ops"
        ],
        "operatorFamilies": "implicit families of the audited classes; not indexes",
        "casts": 8,
        "operators": [
          "!~",
          "!~*",
          "!~~",
          "!~~*",
          "<",
          "<=",
          "<>",
          "=",
          ">",
          ">=",
          "~",
          "~*",
          "~<=~",
          "~<~",
          "~>=~",
          "~>~",
          "~~",
          "~~*"
        ]
      },
      "directRelations": [],
      "directColumns": []
    },
    {
      "name": "pg_trgm",
      "defaultVersion": "1.6",
      "requires": [],
      "relocatable": true,
      "fixedSchema": null,
      "control": {
        "path": "contrib/pg_trgm/pg_trgm.control",
        "bytes": 192,
        "sha256": "17c2745da2a706e1443ee363ab7424ced871a9a652e86bf55d25d139f43ee27b"
      },
      "dispatch": {
        "path": "contrib/pg_trgm/Makefile",
        "bytes": 660,
        "sha256": "766671cc361bf57ad2f25ca9e6de790616ffaa1db0e56b821181b74dadbc8a30"
      },
      "route": [
        {
          "path": "contrib/pg_trgm/pg_trgm--1.3.sql",
          "bytes": 7942,
          "sha256": "2d90a742f644ca794f3819bbefac60bddb53fd9e253bfbc68d6ad3b6d1cf45c4"
        },
        {
          "path": "contrib/pg_trgm/pg_trgm--1.3--1.4.sql",
          "bytes": 2045,
          "sha256": "98763d59a6e221dd1bfc43e941024e4ed363fc05c9ce4514bc93554dfd8a8ed5"
        },
        {
          "path": "contrib/pg_trgm/pg_trgm--1.4--1.5.sql",
          "bytes": 858,
          "sha256": "e5de4624f7dcc3954b4c8d84136f9cc6dfc9942545b091180ca18da41f234d18"
        },
        {
          "path": "contrib/pg_trgm/pg_trgm--1.5--1.6.sql",
          "bytes": 418,
          "sha256": "76d02b6ac7c6a5c2eed44d8fa48c8a104b7af98da594969b19e5bdafbb706bb8"
        }
      ],
      "moduleSourceDigest": "b4f48f8f8ad90778085cb04f001a3de2d172c3ee025ce78be7433a715dc236c3",
      "routines": [
        "gin_extract_query_trgm",
        "gin_extract_value_trgm",
        "gin_trgm_consistent",
        "gin_trgm_triconsistent",
        "gtrgm_compress",
        "gtrgm_consistent",
        "gtrgm_decompress",
        "gtrgm_distance",
        "gtrgm_in",
        "gtrgm_options",
        "gtrgm_out",
        "gtrgm_penalty",
        "gtrgm_picksplit",
        "gtrgm_same",
        "gtrgm_union",
        "set_limit",
        "show_limit",
        "show_trgm",
        "similarity",
        "similarity_dist",
        "similarity_op",
        "strict_word_similarity",
        "strict_word_similarity_commutator_op",
        "strict_word_similarity_dist_commutator_op",
        "strict_word_similarity_dist_op",
        "strict_word_similarity_op",
        "word_similarity",
        "word_similarity_commutator_op",
        "word_similarity_dist_commutator_op",
        "word_similarity_dist_op",
        "word_similarity_op"
      ],
      "baseTypes": [
        "gtrgm"
      ],
      "nonrelationExports": {
        "aggregates": [],
        "operatorClasses": [
          "gin_trgm_ops",
          "gist_trgm_ops"
        ],
        "operatorFamilies": "implicit families of the audited classes; not indexes",
        "casts": 0,
        "operators": [
          "%",
          "%>",
          "%>>",
          "<%",
          "<->",
          "<->>",
          "<->>>",
          "<<%",
          "<<->",
          "<<<->"
        ]
      },
      "directRelations": [],
      "directColumns": []
    },
    {
      "name": "btree_gist",
      "defaultVersion": "1.7",
      "requires": [],
      "relocatable": true,
      "fixedSchema": null,
      "control": {
        "path": "contrib/btree_gist/btree_gist.control",
        "bytes": 178,
        "sha256": "3ca06b88ec216596b06215d9c0cc7f08cd10f0f3fdaf48f58b19bce0464c07ee"
      },
      "dispatch": {
        "path": "contrib/btree_gist/Makefile",
        "bytes": 1318,
        "sha256": "20b0c08ad2f9ce7f8dc289127d27f329494df5a9899b282276fd5256c97a1da7"
      },
      "route": [
        {
          "path": "contrib/btree_gist/btree_gist--1.2.sql",
          "bytes": 41115,
          "sha256": "6ce065d3cf6225cdc56d06ce0e8c18f404b658f18d5ae5b5adc652b69b4a66b4"
        },
        {
          "path": "contrib/btree_gist/btree_gist--1.2--1.3.sql",
          "bytes": 1955,
          "sha256": "5dc7a402185ddbdff6d4488686ba28e3e89c59a850e54f833114f383cda19123"
        },
        {
          "path": "contrib/btree_gist/btree_gist--1.3--1.4.sql",
          "bytes": 1932,
          "sha256": "7a7f5ece012f23d7a11f460e7536b65435ee0aeead0717963a428b092135ab84"
        },
        {
          "path": "contrib/btree_gist/btree_gist--1.4--1.5.sql",
          "bytes": 1872,
          "sha256": "4e28241668ad1ccc0d645ac46726a160617af4d07a8d77f188776e91b085d3ce"
        },
        {
          "path": "contrib/btree_gist/btree_gist--1.5--1.6.sql",
          "bytes": 13417,
          "sha256": "593f167508dc9c6e8be7e5565c15d5fb8d259e38f6139170b72b3da115e2cff4"
        },
        {
          "path": "contrib/btree_gist/btree_gist--1.6--1.7.sql",
          "bytes": 2170,
          "sha256": "426340ca65ed9763e3934c39e5f427e743a4947f6e89eba6bb4c7d9bd3ad0bf5"
        }
      ],
      "moduleSourceDigest": "d5a6e832d7c291fdfe56ce5fc86e53f9ec667f2206367b60f7e7a94f70eccfd3",
      "routines": [
        "cash_dist",
        "date_dist",
        "float4_dist",
        "float8_dist",
        "gbt_bit_compress",
        "gbt_bit_consistent",
        "gbt_bit_penalty",
        "gbt_bit_picksplit",
        "gbt_bit_same",
        "gbt_bit_union",
        "gbt_bool_compress",
        "gbt_bool_consistent",
        "gbt_bool_fetch",
        "gbt_bool_penalty",
        "gbt_bool_picksplit",
        "gbt_bool_same",
        "gbt_bool_union",
        "gbt_bpchar_compress",
        "gbt_bpchar_consistent",
        "gbt_bytea_compress",
        "gbt_bytea_consistent",
        "gbt_bytea_penalty",
        "gbt_bytea_picksplit",
        "gbt_bytea_same",
        "gbt_bytea_union",
        "gbt_cash_compress",
        "gbt_cash_consistent",
        "gbt_cash_distance",
        "gbt_cash_fetch",
        "gbt_cash_penalty",
        "gbt_cash_picksplit",
        "gbt_cash_same",
        "gbt_cash_union",
        "gbt_date_compress",
        "gbt_date_consistent",
        "gbt_date_distance",
        "gbt_date_fetch",
        "gbt_date_penalty",
        "gbt_date_picksplit",
        "gbt_date_same",
        "gbt_date_union",
        "gbt_decompress",
        "gbt_enum_compress",
        "gbt_enum_consistent",
        "gbt_enum_fetch",
        "gbt_enum_penalty",
        "gbt_enum_picksplit",
        "gbt_enum_same",
        "gbt_enum_union",
        "gbt_float4_compress",
        "gbt_float4_consistent",
        "gbt_float4_distance",
        "gbt_float4_fetch",
        "gbt_float4_penalty",
        "gbt_float4_picksplit",
        "gbt_float4_same",
        "gbt_float4_union",
        "gbt_float8_compress",
        "gbt_float8_consistent",
        "gbt_float8_distance",
        "gbt_float8_fetch",
        "gbt_float8_penalty",
        "gbt_float8_picksplit",
        "gbt_float8_same",
        "gbt_float8_union",
        "gbt_inet_compress",
        "gbt_inet_consistent",
        "gbt_inet_penalty",
        "gbt_inet_picksplit",
        "gbt_inet_same",
        "gbt_inet_union",
        "gbt_int2_compress",
        "gbt_int2_consistent",
        "gbt_int2_distance",
        "gbt_int2_fetch",
        "gbt_int2_penalty",
        "gbt_int2_picksplit",
        "gbt_int2_same",
        "gbt_int2_union",
        "gbt_int4_compress",
        "gbt_int4_consistent",
        "gbt_int4_distance",
        "gbt_int4_fetch",
        "gbt_int4_penalty",
        "gbt_int4_picksplit",
        "gbt_int4_same",
        "gbt_int4_union",
        "gbt_int8_compress",
        "gbt_int8_consistent",
        "gbt_int8_distance",
        "gbt_int8_fetch",
        "gbt_int8_penalty",
        "gbt_int8_picksplit",
        "gbt_int8_same",
        "gbt_int8_union",
        "gbt_intv_compress",
        "gbt_intv_consistent",
        "gbt_intv_decompress",
        "gbt_intv_distance",
        "gbt_intv_fetch",
        "gbt_intv_penalty",
        "gbt_intv_picksplit",
        "gbt_intv_same",
        "gbt_intv_union",
        "gbt_macad8_compress",
        "gbt_macad8_consistent",
        "gbt_macad8_fetch",
        "gbt_macad8_penalty",
        "gbt_macad8_picksplit",
        "gbt_macad8_same",
        "gbt_macad8_union",
        "gbt_macad_compress",
        "gbt_macad_consistent",
        "gbt_macad_fetch",
        "gbt_macad_penalty",
        "gbt_macad_picksplit",
        "gbt_macad_same",
        "gbt_macad_union",
        "gbt_numeric_compress",
        "gbt_numeric_consistent",
        "gbt_numeric_penalty",
        "gbt_numeric_picksplit",
        "gbt_numeric_same",
        "gbt_numeric_union",
        "gbt_oid_compress",
        "gbt_oid_consistent",
        "gbt_oid_distance",
        "gbt_oid_fetch",
        "gbt_oid_penalty",
        "gbt_oid_picksplit",
        "gbt_oid_same",
        "gbt_oid_union",
        "gbt_text_compress",
        "gbt_text_consistent",
        "gbt_text_penalty",
        "gbt_text_picksplit",
        "gbt_text_same",
        "gbt_text_union",
        "gbt_time_compress",
        "gbt_time_consistent",
        "gbt_time_distance",
        "gbt_time_fetch",
        "gbt_time_penalty",
        "gbt_time_picksplit",
        "gbt_time_same",
        "gbt_time_union",
        "gbt_timetz_compress",
        "gbt_timetz_consistent",
        "gbt_ts_compress",
        "gbt_ts_consistent",
        "gbt_ts_distance",
        "gbt_ts_fetch",
        "gbt_ts_penalty",
        "gbt_ts_picksplit",
        "gbt_ts_same",
        "gbt_ts_union",
        "gbt_tstz_compress",
        "gbt_tstz_consistent",
        "gbt_tstz_distance",
        "gbt_uuid_compress",
        "gbt_uuid_consistent",
        "gbt_uuid_fetch",
        "gbt_uuid_penalty",
        "gbt_uuid_picksplit",
        "gbt_uuid_same",
        "gbt_uuid_union",
        "gbt_var_decompress",
        "gbt_var_fetch",
        "gbtreekey16_in",
        "gbtreekey16_out",
        "gbtreekey2_in",
        "gbtreekey2_out",
        "gbtreekey32_in",
        "gbtreekey32_out",
        "gbtreekey4_in",
        "gbtreekey4_out",
        "gbtreekey8_in",
        "gbtreekey8_out",
        "gbtreekey_var_in",
        "gbtreekey_var_out",
        "int2_dist",
        "int4_dist",
        "int8_dist",
        "interval_dist",
        "oid_dist",
        "time_dist",
        "ts_dist",
        "tstz_dist"
      ],
      "baseTypes": [
        "gbtreekey16",
        "gbtreekey2",
        "gbtreekey32",
        "gbtreekey4",
        "gbtreekey8",
        "gbtreekey_var"
      ],
      "nonrelationExports": {
        "aggregates": [],
        "operatorClasses": [
          "gist_bit_ops",
          "gist_bool_ops",
          "gist_bpchar_ops",
          "gist_bytea_ops",
          "gist_cash_ops",
          "gist_cidr_ops",
          "gist_date_ops",
          "gist_enum_ops",
          "gist_float4_ops",
          "gist_float8_ops",
          "gist_inet_ops",
          "gist_int2_ops",
          "gist_int4_ops",
          "gist_int8_ops",
          "gist_interval_ops",
          "gist_macaddr8_ops",
          "gist_macaddr_ops",
          "gist_numeric_ops",
          "gist_oid_ops",
          "gist_text_ops",
          "gist_time_ops",
          "gist_timestamp_ops",
          "gist_timestamptz_ops",
          "gist_timetz_ops",
          "gist_uuid_ops",
          "gist_vbit_ops"
        ],
        "operatorFamilies": "implicit families of the audited classes; not indexes",
        "casts": 0,
        "operators": [
          "<->"
        ]
      },
      "directRelations": [],
      "directColumns": []
    }
  ]
} as const;
