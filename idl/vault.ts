/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/vault.json`.
 */
export type Vault = {
  "address": "J7mfFVqo7L8jKHiVREeBti6cVrDLyHGQcUT3tHrgfNEJ",
  "metadata": {
    "name": "vault",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "SilentEdge non-custodial trading vault"
  },
  "instructions": [
    {
      "name": "convertStrategy",
      "docs": [
        "Re-encrypt the submitted strategy from `Enc<Shared, _>` to `Enc<Mxe, _>`.",
        "",
        "Owner-signed: this reads the strategy the owner submitted and hands it to",
        "the cluster. Evaluation afterwards needs nobody online."
      ],
      "discriminator": [
        107,
        215,
        99,
        141,
        118,
        112,
        26,
        75
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "vaultConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "payer"
              }
            ]
          }
        },
        {
          "name": "strategyState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  97,
                  116,
                  101,
                  103,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig"
              }
            ]
          }
        },
        {
          "name": "signPdaAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  65,
                  114,
                  99,
                  105,
                  117,
                  109,
                  83,
                  105,
                  103,
                  110,
                  101,
                  114,
                  65,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "mxeAccount"
        },
        {
          "name": "mempoolAccount",
          "writable": true
        },
        {
          "name": "executingPool",
          "writable": true
        },
        {
          "name": "computationAccount",
          "writable": true
        },
        {
          "name": "compDefAccount"
        },
        {
          "name": "clusterAccount",
          "writable": true
        },
        {
          "name": "poolAccount",
          "writable": true,
          "address": "G2sRWJvi3xoyh5k2gY49eG9L8YhAEWQPtNb1zb1GXTtC"
        },
        {
          "name": "clockAccount",
          "writable": true,
          "address": "7EbMUTLo5DjdzbN7s8BXeZwXzEwNQb1hScfRvWg8a6ot"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "arciumProgram",
          "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
        }
      ],
      "args": [
        {
          "name": "computationOffset",
          "type": "u64"
        }
      ]
    },
    {
      "name": "copyStrategy",
      "docs": [
        "Follow a listed vault by copying its encrypted strategy into your own.",
        "",
        "# Why copying the ciphertext is safe",
        "",
        "`Enc<Mxe, Strategy>` is encrypted to the *cluster*, not to a person. The",
        "follower ends up holding bytes they cannot decrypt, and which were",
        "already published on the leader's account — copying them discloses",
        "nothing that was not already on chain. The cluster can evaluate them",
        "wherever they sit, so the follower's vault becomes evaluable without",
        "anyone learning a threshold.",
        "",
        "# What the follower keeps",
        "",
        "Their own limits, their own balances, their own vault. The copied",
        "strategy decides the *side*; `size_bps`, `max_trade_bps`, the cooldown",
        "and the slippage floor are all read from the follower's own config at",
        "evaluation and execution. Following someone does not adopt their risk",
        "appetite, and cannot be used to route around your own limits.",
        "",
        "Requires the leader to be listed. Listing is the owner's explicit,",
        "revocable statement that the vault is public; without it this would let",
        "anyone copy a strategy from a vault that never offered one."
      ],
      "discriminator": [
        13,
        104,
        107,
        86,
        214,
        107,
        241,
        173
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vaultConfig"
          ]
        },
        {
          "name": "vaultConfig",
          "docs": [
            "The follower's vault. Seeded by the signer, so this can only ever write",
            "into a vault the caller owns."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "strategyState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  97,
                  116,
                  101,
                  103,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig"
              }
            ]
          }
        },
        {
          "name": "leaderVault",
          "docs": [
            "The vault being followed. Read only — nothing here can modify it."
          ]
        },
        {
          "name": "leaderStrategy",
          "docs": [
            "The leader's strategy, tied to the leader's vault by its seeds so a",
            "caller cannot pair one vault's listing with another vault's strategy."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  97,
                  116,
                  101,
                  103,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "leaderVault"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "deposit",
      "docs": [
        "Move tokens from the owner's wallet into the vault.",
        "",
        "Blocked unless the vault is `Active`: if a vault is paused or stopped,",
        "something is wrong with it and it should not be taking more money."
      ],
      "discriminator": [
        242,
        35,
        198,
        137,
        82,
        225,
        242,
        182
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vaultConfig"
          ]
        },
        {
          "name": "vaultConfig",
          "docs": [
            "Seeded by `owner`, so a signer can only ever reach their own vault."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "ownerAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "vaultAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vaultConfig"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "evaluateStrategy",
      "docs": [
        "Evaluate the strategy against the live oracle price.",
        "",
        "Permissionless by design. Evaluation reveals nothing, authorizes nothing",
        "on its own, and a permissionless scheduler is what stops the operator",
        "censoring a user's bot by declining to run it.",
        "",
        "Both inputs the caller could once have lied about are now read on chain:",
        "the price from Pyth, and the vault's value from its own token accounts."
      ],
      "discriminator": [
        146,
        95,
        255,
        59,
        126,
        68,
        98,
        238
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "vaultConfig",
          "docs": [
            "Not seeded by `payer`: anyone may evaluate. Nothing is revealed and",
            "nothing is authorized by evaluating, and permissionless scheduling is",
            "what stops the operator censoring a user's bot."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig.owner",
                "account": "vaultConfig"
              }
            ]
          }
        },
        {
          "name": "strategyState",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  97,
                  116,
                  101,
                  103,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig"
              }
            ]
          }
        },
        {
          "name": "tradeIntent",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  116,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig"
              }
            ]
          }
        },
        {
          "name": "vaultQuoteAta",
          "docs": [
            "The vault's own quote balance. Read here rather than passed in, so a",
            "caller cannot inflate the size of someone else's trade."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vaultConfig"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig.quoteMint",
                "account": "vaultConfig"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "vaultBaseAta",
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vaultConfig"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig.baseMint",
                "account": "vaultConfig"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "priceUpdate"
        },
        {
          "name": "signPdaAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  65,
                  114,
                  99,
                  105,
                  117,
                  109,
                  83,
                  105,
                  103,
                  110,
                  101,
                  114,
                  65,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "mxeAccount"
        },
        {
          "name": "mempoolAccount",
          "writable": true
        },
        {
          "name": "executingPool",
          "writable": true
        },
        {
          "name": "computationAccount",
          "writable": true
        },
        {
          "name": "compDefAccount"
        },
        {
          "name": "clusterAccount",
          "writable": true
        },
        {
          "name": "poolAccount",
          "writable": true,
          "address": "G2sRWJvi3xoyh5k2gY49eG9L8YhAEWQPtNb1zb1GXTtC"
        },
        {
          "name": "clockAccount",
          "writable": true,
          "address": "7EbMUTLo5DjdzbN7s8BXeZwXzEwNQb1hScfRvWg8a6ot"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "arciumProgram",
          "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
        }
      ],
      "args": [
        {
          "name": "computationOffset",
          "type": "u64"
        }
      ]
    },
    {
      "name": "evaluateStrategyV3Callback",
      "docs": [
        "Turn a verified decision into a bounded trade authorization.",
        "",
        "This is the only writer of `TradeIntent`, and the only thing that can",
        "authorize vault funds into a swap. It authorizes a side and a size inside",
        "a slot window — never a destination, never a program, never a withdrawal."
      ],
      "discriminator": [
        43,
        136,
        87,
        9,
        221,
        222,
        214,
        254
      ],
      "accounts": [
        {
          "name": "arciumProgram",
          "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
        },
        {
          "name": "compDefAccount"
        },
        {
          "name": "mxeAccount"
        },
        {
          "name": "computationAccount"
        },
        {
          "name": "clusterAccount"
        },
        {
          "name": "instructionsSysvar",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "tradeIntent",
          "writable": true
        },
        {
          "name": "vaultConfig"
        },
        {
          "name": "strategyState",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  97,
                  116,
                  101,
                  103,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "output",
          "type": {
            "defined": {
              "name": "signedComputationOutputs",
              "generics": [
                {
                  "kind": "type",
                  "type": {
                    "defined": {
                      "name": "evaluateStrategyV3Output"
                    }
                  }
                }
              ]
            }
          }
        }
      ]
    },
    {
      "name": "executeTrade",
      "docs": [
        "Consume a trade authorization.",
        "",
        "Callable by anyone. That is safe because the executor holds no privilege:",
        "every parameter of the trade is already fixed in `TradeIntent`, and every",
        "rule is checked here against on-chain state rather than against anything",
        "the caller supplies. The executor chooses only whether and when to submit",
        "inside the window — a liveness role, not a trust role. Users can always",
        "self-execute, so a vanished operator cannot strand them.",
        "",
        "What this cannot do, by construction rather than by check: withdraw,",
        "choose a destination, change the vault owner, change the strategy, call",
        "an arbitrary program, or exceed the vault's own limits.",
        "",
        "The swap itself lands in the trading phase. Everything before it — the",
        "authorization checks — is here, because that is the part that has to be",
        "right before any funds move."
      ],
      "discriminator": [
        77,
        16,
        192,
        135,
        13,
        0,
        106,
        97
      ],
      "accounts": [
        {
          "name": "executor",
          "docs": [
            "Permissionless. Holds no privilege; pays the fee and picks the moment."
          ],
          "signer": true
        },
        {
          "name": "vaultConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig.owner",
                "account": "vaultConfig"
              }
            ]
          }
        },
        {
          "name": "tradeIntent",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  116,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig"
              }
            ]
          }
        },
        {
          "name": "strategyState",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  97,
                  116,
                  101,
                  103,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig"
              }
            ]
          }
        },
        {
          "name": "vaultQuoteAta",
          "docs": [
            "Both vault ATAs, because either can be the source depending on side.",
            "Derived from `vault_config`, never passed loose — a destination the",
            "caller can choose is a rug waiting for a bug."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vaultConfig"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig.quoteMint",
                "account": "vaultConfig"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "vaultBaseAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vaultConfig"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig.baseMint",
                "account": "vaultConfig"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "priceUpdate"
        },
        {
          "name": "jupiterProgram",
          "docs": [
            "Pinned. The only program this instruction will CPI into."
          ],
          "address": "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
        }
      ],
      "args": [
        {
          "name": "routeData",
          "type": "bytes"
        }
      ]
    },
    {
      "name": "initEvaluateStrategyCompDef",
      "discriminator": [
        230,
        79,
        140,
        38,
        91,
        90,
        166,
        37
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "mxeAccount",
          "writable": true
        },
        {
          "name": "compDefAccount",
          "writable": true
        },
        {
          "name": "addressLookupTable",
          "writable": true
        },
        {
          "name": "lutProgram",
          "address": "AddressLookupTab1e1111111111111111111111111"
        },
        {
          "name": "arciumProgram",
          "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initStoreStrategyCompDef",
      "discriminator": [
        56,
        183,
        123,
        159,
        65,
        77,
        189,
        206
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "mxeAccount",
          "writable": true
        },
        {
          "name": "compDefAccount",
          "writable": true
        },
        {
          "name": "addressLookupTable",
          "writable": true
        },
        {
          "name": "lutProgram",
          "address": "AddressLookupTab1e1111111111111111111111111"
        },
        {
          "name": "arciumProgram",
          "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initTradeIntent",
      "docs": [
        "Create the account a verified callback will write authorizations into."
      ],
      "discriminator": [
        205,
        156,
        78,
        133,
        126,
        18,
        131,
        179
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vaultConfig"
          ]
        },
        {
          "name": "vaultConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "tradeIntent",
          "docs": [
            "Created ahead of time because an Arcium callback cannot create accounts —",
            "it can only write to ones declared writable when the computation was queued."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  116,
                  101,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initializeVault",
      "docs": [
        "Create a vault and its two program-owned token accounts."
      ],
      "discriminator": [
        48,
        191,
        163,
        44,
        71,
        129,
        63,
        164
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "vaultConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "baseMint"
        },
        {
          "name": "quoteMint"
        },
        {
          "name": "vaultBaseAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vaultConfig"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "baseMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "vaultQuoteAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vaultConfig"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "quoteMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "limits",
          "type": {
            "defined": {
              "name": "riskLimits"
            }
          }
        }
      ]
    },
    {
      "name": "pause",
      "docs": [
        "Circuit breaker. Owner only.",
        "",
        "There was a `GUARDIAN` branch here. It resolved to this program's own id,",
        "which is the public key of the deploy keypair — so it granted the",
        "deployer the power to pause any user's vault. See constants.rs for why it",
        "is gone rather than repointed. Pausing stops new trades and never blocks",
        "`withdraw`."
      ],
      "discriminator": [
        211,
        22,
        221,
        251,
        74,
        121,
        193,
        47
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "vaultConfig",
          "docs": [
            "Seeded by `vault_config.owner` rather than by `authority`, a shape left",
            "over from the removed guardian. Every handler now checks",
            "`authority == vault_config.owner` explicitly, so this is equivalent to",
            "seeding by the signer — but the explicit check is what enforces it."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig.owner",
                "account": "vaultConfig"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "resume",
      "docs": [
        "Return a paused vault to service. Owner only."
      ],
      "discriminator": [
        1,
        166,
        51,
        170,
        127,
        32,
        141,
        206
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "vaultConfig",
          "docs": [
            "Seeded by `vault_config.owner` rather than by `authority`, a shape left",
            "over from the removed guardian. Every handler now checks",
            "`authority == vault_config.owner` explicitly, so this is equivalent to",
            "seeding by the signer — but the explicit check is what enforces it."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig.owner",
                "account": "vaultConfig"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "setExposureLimits",
      "docs": [
        "Set the concentration ceiling and the minimum trade size. Owner only.",
        "",
        "A separate instruction rather than two more fields on `RiskLimits`,",
        "because `RiskLimits` sits in the middle of `VaultConfig` — adding to it",
        "shifts the offset of every field after it and strands every existing",
        "vault, which is exactly the mistake this codebase already made once and",
        "documented at `VaultConfig::reserved`.",
        "",
        "Both default to 0, meaning disabled, which is what a vault created",
        "before these existed reads out of zeroed reserve bytes."
      ],
      "discriminator": [
        98,
        72,
        37,
        179,
        241,
        1,
        90,
        85
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vaultConfig"
          ]
        },
        {
          "name": "vaultConfig",
          "docs": [
            "Seeded by `owner` and `has_one` checked, so a signer can only ever reach",
            "their own vault's limits."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "maxBaseExposureBps",
          "type": "u16"
        },
        {
          "name": "minTradeBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "setListing",
      "docs": [
        "List or unlist this vault in public discovery. Owner only.",
        "",
        "Listing changes what is *findable*, never what is readable. Everything a",
        "listing surfaces — balances, limits, trade history — was already public",
        "on chain; the encrypted strategy stays encrypted, because no instruction",
        "in this program can export it.",
        "",
        "Deliberately not gated on having a strategy or a balance: an owner may",
        "want to unlist instantly, and adding conditions to that is adding ways",
        "for it to fail when it matters."
      ],
      "discriminator": [
        61,
        63,
        131,
        242,
        184,
        230,
        149,
        123
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vaultConfig"
          ]
        },
        {
          "name": "vaultConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "listed",
          "type": "bool"
        },
        {
          "name": "name",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "stop",
      "docs": [
        "Terminal wind-down. Owner only, irreversible. Withdrawals still work."
      ],
      "discriminator": [
        42,
        133,
        32,
        60,
        171,
        253,
        184,
        155
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "vaultConfig",
          "docs": [
            "Seeded by `vault_config.owner` rather than by `authority`, a shape left",
            "over from the removed guardian. Every handler now checks",
            "`authority == vault_config.owner` explicitly, so this is equivalent to",
            "seeding by the signer — but the explicit check is what enforces it."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig.owner",
                "account": "vaultConfig"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "storeStrategyV2Callback",
      "discriminator": [
        89,
        47,
        158,
        38,
        10,
        217,
        244,
        188
      ],
      "accounts": [
        {
          "name": "arciumProgram",
          "address": "Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ"
        },
        {
          "name": "compDefAccount"
        },
        {
          "name": "mxeAccount"
        },
        {
          "name": "computationAccount"
        },
        {
          "name": "clusterAccount"
        },
        {
          "name": "instructionsSysvar",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "strategyState",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "output",
          "type": {
            "defined": {
              "name": "signedComputationOutputs",
              "generics": [
                {
                  "kind": "type",
                  "type": {
                    "defined": {
                      "name": "storeStrategyV2Output"
                    }
                  }
                }
              ]
            }
          }
        }
      ]
    },
    {
      "name": "submitStrategy",
      "docs": [
        "Store an encrypted strategy for a vault, or replace the existing one.",
        "",
        "The program validates shape and authority, never content. It has no way",
        "to read the ciphertext and no reason to: the whole point is that the",
        "operator running this program learns nothing from it.",
        "",
        "Uses `init_if_needed` because submitting is create-or-replace. The usual",
        "re-initialization risk does not apply here — the account is seeded by the",
        "vault, the vault is seeded by the owner, and the owner must sign, so no",
        "one else can reach it."
      ],
      "discriminator": [
        82,
        215,
        84,
        162,
        33,
        116,
        58,
        208
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true,
          "relations": [
            "vaultConfig"
          ]
        },
        {
          "name": "vaultConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "strategyState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  114,
                  97,
                  116,
                  101,
                  103,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "vaultConfig"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "ciphertexts",
          "type": {
            "array": [
              {
                "array": [
                  "u8",
                  32
                ]
              },
              3
            ]
          }
        },
        {
          "name": "nonce",
          "type": "u128"
        },
        {
          "name": "encryptionPubkey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "updateLimits",
      "docs": [
        "Replace the vault's risk envelope. Owner only.",
        "",
        "Limits were write-once, and the vault PDA is one-per-owner with no close",
        "instruction — so a cooldown or trade cap set badly at creation was",
        "permanent for that vault, with no way out but abandoning it. That is only",
        "tolerable while the limits are inert; it stops being tolerable the moment",
        "they are enforced.",
        "",
        "Bumps `nonce`, which invalidates any authorization already in flight. An",
        "intent carries no copy of the envelope it was issued under, so without",
        "the bump a decision made under the old limits would execute under the new",
        "ones. There is no timelock and no tighten-only ratchet on purpose: both",
        "would guard a strictly weaker path than `withdraw`, which sends 100% to",
        "the owner with no delay and no cap. A stolen owner key does not need this",
        "instruction."
      ],
      "discriminator": [
        89,
        37,
        137,
        60,
        75,
        70,
        48,
        194
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vaultConfig"
          ]
        },
        {
          "name": "vaultConfig",
          "docs": [
            "Seeded by `owner` and `has_one` checked, so a signer can only ever reach",
            "their own vault's limits."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "limits",
          "type": {
            "defined": {
              "name": "riskLimits"
            }
          }
        }
      ]
    },
    {
      "name": "withdraw",
      "docs": [
        "Move tokens from the vault back to the owner.",
        "",
        "Deliberately ignores `status`. A paused, stopped, or otherwise broken",
        "vault must still let its owner out — see SECURITY.md T-4 and §8.1.",
        "Touches no Arcium account, so this keeps working if the MPC network,",
        "our backend, and our executor are all unavailable."
      ],
      "discriminator": [
        183,
        18,
        70,
        156,
        148,
        109,
        161,
        34
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true,
          "relations": [
            "vaultConfig"
          ]
        },
        {
          "name": "vaultConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "ownerAta",
          "docs": [
            "Destination is derived from `owner`, never supplied as a parameter."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "owner"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "vaultAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "vaultConfig"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "arciumSignerAccount",
      "discriminator": [
        214,
        157,
        122,
        114,
        117,
        44,
        214,
        74
      ]
    },
    {
      "name": "strategyState",
      "discriminator": [
        83,
        18,
        224,
        109,
        174,
        100,
        39,
        139
      ]
    },
    {
      "name": "tradeIntent",
      "discriminator": [
        245,
        187,
        15,
        112,
        10,
        112,
        37,
        229
      ]
    },
    {
      "name": "vaultConfig",
      "discriminator": [
        99,
        86,
        43,
        216,
        184,
        102,
        119,
        77
      ]
    }
  ],
  "events": [
    {
      "name": "deposited",
      "discriminator": [
        111,
        141,
        26,
        45,
        161,
        35,
        100,
        57
      ]
    },
    {
      "name": "evaluationHeld",
      "discriminator": [
        63,
        249,
        2,
        120,
        116,
        96,
        151,
        95
      ]
    },
    {
      "name": "limitsUpdated",
      "discriminator": [
        160,
        131,
        108,
        76,
        91,
        80,
        118,
        137
      ]
    },
    {
      "name": "listingChanged",
      "discriminator": [
        250,
        3,
        123,
        146,
        103,
        105,
        212,
        176
      ]
    },
    {
      "name": "statusChanged",
      "discriminator": [
        146,
        235,
        222,
        125,
        145,
        246,
        34,
        240
      ]
    },
    {
      "name": "strategyConverted",
      "discriminator": [
        8,
        245,
        34,
        189,
        104,
        82,
        201,
        100
      ]
    },
    {
      "name": "strategyCopied",
      "discriminator": [
        193,
        167,
        255,
        39,
        107,
        194,
        173,
        105
      ]
    },
    {
      "name": "strategySubmitted",
      "discriminator": [
        209,
        180,
        175,
        209,
        217,
        135,
        142,
        212
      ]
    },
    {
      "name": "tradeAuthorized",
      "discriminator": [
        153,
        52,
        113,
        132,
        14,
        124,
        19,
        200
      ]
    },
    {
      "name": "tradeExecuted",
      "discriminator": [
        41,
        110,
        64,
        129,
        60,
        79,
        179,
        80
      ]
    },
    {
      "name": "vaultInitialized",
      "discriminator": [
        180,
        43,
        207,
        2,
        18,
        71,
        3,
        75
      ]
    },
    {
      "name": "withdrawn",
      "discriminator": [
        20,
        89,
        223,
        198,
        194,
        124,
        219,
        13
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "mintNotAllowed",
      "msg": "Mint is not on the allowlist"
    },
    {
      "code": 6001,
      "name": "vaultNotActive",
      "msg": "Vault is not active"
    },
    {
      "code": 6002,
      "name": "vaultStopped",
      "msg": "Vault is stopped"
    },
    {
      "code": 6003,
      "name": "zeroAmount",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6004,
      "name": "insufficientBalance",
      "msg": "Insufficient vault balance"
    },
    {
      "code": 6005,
      "name": "invalidRiskLimit",
      "msg": "Risk limit is outside the permitted range"
    },
    {
      "code": 6006,
      "name": "notPauseAuthority",
      "msg": "Signer is not authorized to pause this vault"
    },
    {
      "code": 6007,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6008,
      "name": "invalidEncryptionKey",
      "msg": "Encryption public key must not be all zeros"
    },
    {
      "code": 6009,
      "name": "noStrategyStored",
      "msg": "No strategy has been stored for this vault"
    },
    {
      "code": 6010,
      "name": "strategyNotConverted",
      "msg": "Strategy has not been converted to MXE-encrypted state yet"
    },
    {
      "code": 6011,
      "name": "abortedComputation",
      "msg": "The computation was aborted or could not be verified"
    },
    {
      "code": 6012,
      "name": "unexpectedCluster",
      "msg": "Result came from a cluster this vault does not accept"
    },
    {
      "code": 6013,
      "name": "noTradeAuthorized",
      "msg": "No trade is currently authorized"
    },
    {
      "code": 6014,
      "name": "intentAlreadyConsumed",
      "msg": "This trade authorization has already been used"
    },
    {
      "code": 6015,
      "name": "intentExpired",
      "msg": "This trade authorization has expired"
    },
    {
      "code": 6016,
      "name": "intentStale",
      "msg": "Trade authorization does not match the vault's current nonce"
    },
    {
      "code": 6017,
      "name": "intentStrategyMismatch",
      "msg": "Trade authorization was issued for a different strategy version"
    },
    {
      "code": 6018,
      "name": "tradeTooLarge",
      "msg": "Trade exceeds the vault's maximum trade size"
    },
    {
      "code": 6019,
      "name": "cooldownActive",
      "msg": "Cooldown between trades has not elapsed"
    },
    {
      "code": 6020,
      "name": "oracleDeviationTooLarge",
      "msg": "Execution price deviates too far from the oracle"
    },
    {
      "code": 6021,
      "name": "nonPositivePrice",
      "msg": "Oracle price is zero or negative"
    },
    {
      "code": 6022,
      "name": "confidenceTooWide",
      "msg": "Oracle confidence interval is too wide to trade on"
    },
    {
      "code": 6023,
      "name": "priceOutOfBand",
      "msg": "Oracle price is outside the reasonable band"
    },
    {
      "code": 6024,
      "name": "exponentOutOfRange",
      "msg": "Oracle exponent is outside the supported range"
    },
    {
      "code": 6025,
      "name": "scalingOverflow",
      "msg": "Arithmetic overflow scaling the oracle price"
    },
    {
      "code": 6026,
      "name": "insufficientSourceBalance",
      "msg": "Vault does not hold enough of the input mint for this trade"
    },
    {
      "code": 6027,
      "name": "unexpectedSourceDelta",
      "msg": "Swap moved an unexpected amount out of the vault"
    },
    {
      "code": 6028,
      "name": "slippageExceeded",
      "msg": "Swap returned less than the oracle-derived minimum"
    },
    {
      "code": 6029,
      "name": "vaultLamportsChanged",
      "msg": "Swap changed the vault account's lamports"
    },
    {
      "code": 6030,
      "name": "unknownSide",
      "msg": "Trade intent carries an unknown side"
    },
    {
      "code": 6031,
      "name": "swapProgramNotAllowed",
      "msg": "Swap program is not the pinned aggregator"
    },
    {
      "code": 6032,
      "name": "vaultNotListed",
      "msg": "That vault is not listed for public discovery"
    },
    {
      "code": 6033,
      "name": "cannotFollowSelf",
      "msg": "A vault cannot follow itself"
    },
    {
      "code": 6034,
      "name": "exposureLimitReached",
      "msg": "Trade would push base exposure past the vault's ceiling"
    },
    {
      "code": 6035,
      "name": "tradeTooSmall",
      "msg": "Trade is too small to be worth its costs"
    },
    {
      "code": 6036,
      "name": "destinationDrained",
      "msg": "Swap reduced the destination balance"
    },
    {
      "code": 6037,
      "name": "strategySuperseded",
      "msg": "The strategy was replaced while this conversion was in flight"
    }
  ],
  "types": [
    {
      "name": "activation",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "activationEpoch",
            "type": {
              "defined": {
                "name": "epoch"
              }
            }
          },
          {
            "name": "deactivationEpoch",
            "type": {
              "defined": {
                "name": "epoch"
              }
            }
          }
        ]
      }
    },
    {
      "name": "arciumSignerAccount",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "bn254g2blsPublicKey",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "array": [
              "u8",
              64
            ]
          }
        ]
      }
    },
    {
      "name": "circuitSource",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "local",
            "fields": [
              {
                "defined": {
                  "name": "localCircuitSource"
                }
              }
            ]
          },
          {
            "name": "onChain",
            "fields": [
              {
                "defined": {
                  "name": "onChainCircuitSource"
                }
              }
            ]
          },
          {
            "name": "offChain",
            "fields": [
              {
                "defined": {
                  "name": "offChainCircuitSource"
                }
              }
            ]
          }
        ]
      }
    },
    {
      "name": "clockAccount",
      "docs": [
        "An account storing the current network epoch"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "startEpoch",
            "type": {
              "defined": {
                "name": "epoch"
              }
            }
          },
          {
            "name": "currentEpoch",
            "type": {
              "defined": {
                "name": "epoch"
              }
            }
          },
          {
            "name": "startEpochTimestamp",
            "type": {
              "defined": {
                "name": "timestamp"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "cluster",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "tdInfo",
            "type": {
              "option": {
                "defined": {
                  "name": "nodeMetadata"
                }
              }
            }
          },
          {
            "name": "authority",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "clusterSize",
            "type": "u16"
          },
          {
            "name": "activation",
            "type": {
              "defined": {
                "name": "activation"
              }
            }
          },
          {
            "name": "maxCapacity",
            "type": "u64"
          },
          {
            "name": "cuPrice",
            "type": "u64"
          },
          {
            "name": "cuPriceProposals",
            "type": {
              "array": [
                "u64",
                32
              ]
            }
          },
          {
            "name": "lastUpdatedEpoch",
            "type": {
              "defined": {
                "name": "epoch"
              }
            }
          },
          {
            "name": "nodes",
            "type": {
              "vec": {
                "defined": {
                  "name": "nodeRef"
                }
              }
            }
          },
          {
            "name": "pendingNodes",
            "type": {
              "vec": "u32"
            }
          },
          {
            "name": "blsPublicKey",
            "type": {
              "defined": {
                "name": "setUnset",
                "generics": [
                  {
                    "kind": "type",
                    "type": {
                      "defined": {
                        "name": "bn254g2blsPublicKey"
                      }
                    }
                  }
                ]
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "currentEpochTotalRewards",
            "type": "u64"
          },
          {
            "name": "rewardsEpoch",
            "type": {
              "defined": {
                "name": "epoch"
              }
            }
          },
          {
            "name": "leaderSelector",
            "type": {
              "defined": {
                "name": "leaderSelector"
              }
            }
          }
        ]
      }
    },
    {
      "name": "computationDefinitionAccount",
      "docs": [
        "An account representing a [ComputationDefinition] in a MXE."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "deactivationSlot",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "cuAmount",
            "type": "u64"
          },
          {
            "name": "definition",
            "type": {
              "defined": {
                "name": "computationDefinitionMeta"
              }
            }
          },
          {
            "name": "circuitSource",
            "type": {
              "defined": {
                "name": "circuitSource"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "padding",
            "type": {
              "array": [
                "u8",
                24
              ]
            }
          }
        ]
      }
    },
    {
      "name": "computationDefinitionMeta",
      "docs": [
        "A computation definition for execution in a MXE."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "circuitLen",
            "type": "u32"
          },
          {
            "name": "signature",
            "type": {
              "defined": {
                "name": "computationSignature"
              }
            }
          }
        ]
      }
    },
    {
      "name": "computationSignature",
      "docs": [
        "The signature of a computation defined in a [ComputationDefinition]."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "parameters",
            "type": {
              "vec": {
                "defined": {
                  "name": "parameter"
                }
              }
            }
          },
          {
            "name": "outputs",
            "type": {
              "vec": {
                "defined": {
                  "name": "output"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "deposited",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "epoch",
      "docs": [
        "The network epoch"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          "u64"
        ]
      }
    },
    {
      "name": "evaluateStrategyV3Output",
      "docs": [
        "The output of the callback instruction. Provided as a struct with ordered fields",
        "as anchor does not support tuples and tuple structs yet."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "field0",
            "type": {
              "defined": {
                "name": "evaluateStrategyV3OutputStruct0"
              }
            }
          }
        ]
      }
    },
    {
      "name": "evaluateStrategyV3OutputStruct0",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "field0",
            "type": "u8"
          },
          {
            "name": "field1",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "evaluationHeld",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "feePool",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "leaderChoice",
      "docs": [
        "The computation chosen by a node to be executed when the node is leader."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "offset",
            "type": "u64"
          },
          {
            "name": "slotIdx",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "leaderInfo",
      "docs": [
        "The information about a node."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "stake",
            "type": "u64"
          },
          {
            "name": "count",
            "type": "u64"
          },
          {
            "name": "lastCounterPlusOne",
            "type": "u64"
          },
          {
            "name": "choice",
            "type": {
              "defined": {
                "name": "leaderChoice"
              }
            }
          }
        ]
      }
    },
    {
      "name": "leaderSelector",
      "docs": [
        "To select a Leader.",
        "Uses the greatest divisors method: https://en.wikipedia.org/wiki/D%27Hondt_method"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "stakingEpoch",
            "type": {
              "defined": {
                "name": "epoch"
              }
            }
          },
          {
            "name": "info",
            "type": {
              "vec": {
                "defined": {
                  "name": "leaderInfo"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "limitsUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "docs": [
              "The bumped nonce, which is also the receipt that any in-flight",
              "authorization was invalidated."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "listingChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "listed",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "localCircuitSource",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "mxeKeygen"
          },
          {
            "name": "mxeKeyRecoveryInit"
          },
          {
            "name": "mxeKeyRecoveryFinalize"
          }
        ]
      }
    },
    {
      "name": "mxeAccount",
      "docs": [
        "A MPC Execution Environment."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "padding",
            "type": "u8"
          },
          {
            "name": "cluster",
            "type": "u32"
          },
          {
            "name": "keygenOffset",
            "type": "u64"
          },
          {
            "name": "keyRecoveryInitOffset",
            "type": "u64"
          },
          {
            "name": "mxeProgramId",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "utilityPubkeys",
            "type": {
              "defined": {
                "name": "setUnset",
                "generics": [
                  {
                    "kind": "type",
                    "type": {
                      "defined": {
                        "name": "utilityPubkeys"
                      }
                    }
                  }
                ]
              }
            }
          },
          {
            "name": "lutOffsetSlot",
            "type": "u64"
          },
          {
            "name": "computationDefinitions",
            "type": {
              "vec": "u32"
            }
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "mxeStatus"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "currentEpochRecoveryRewards",
            "type": "u64"
          },
          {
            "name": "recoveryRewardsEpoch",
            "type": {
              "defined": {
                "name": "epoch"
              }
            }
          }
        ]
      }
    },
    {
      "name": "mxeEncryptedStruct",
      "generics": [
        {
          "kind": "const",
          "name": "len",
          "type": "usize"
        }
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "nonce",
            "type": "u128"
          },
          {
            "name": "ciphertexts",
            "type": {
              "array": [
                {
                  "array": [
                    "u8",
                    32
                  ]
                },
                {
                  "generic": "len"
                }
              ]
            }
          }
        ]
      }
    },
    {
      "name": "mxeStatus",
      "docs": [
        "The status of an MXE."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "active"
          },
          {
            "name": "migration"
          }
        ]
      }
    },
    {
      "name": "nodeMetadata",
      "docs": [
        "location as [ISO 3166-1 alpha-2](https://www.iso.org/iso-3166-country-codes.html) country code"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ip",
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          },
          {
            "name": "peerId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "location",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "nodeRef",
      "docs": [
        "A reference to a node in the cluster.",
        "The offset is to derive the Node Account."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "offset",
            "type": "u32"
          },
          {
            "name": "padding",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "vote",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "offChainCircuitSource",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "source",
            "type": "string"
          },
          {
            "name": "hash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "onChainCircuitSource",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "isCompleted",
            "type": "bool"
          },
          {
            "name": "uploadAuth",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "output",
      "docs": [
        "An output of a computation.",
        "We currently don't support encrypted outputs yet since encrypted values are passed via",
        "data objects."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "plaintextBool"
          },
          {
            "name": "plaintextU8"
          },
          {
            "name": "plaintextU16"
          },
          {
            "name": "plaintextU32"
          },
          {
            "name": "plaintextU64"
          },
          {
            "name": "plaintextU128"
          },
          {
            "name": "ciphertext"
          },
          {
            "name": "arcisX25519Pubkey"
          },
          {
            "name": "plaintextFloat"
          },
          {
            "name": "plaintextPoint"
          },
          {
            "name": "plaintextI8"
          },
          {
            "name": "plaintextI16"
          },
          {
            "name": "plaintextI32"
          },
          {
            "name": "plaintextI64"
          },
          {
            "name": "plaintextI128"
          }
        ]
      }
    },
    {
      "name": "parameter",
      "docs": [
        "A parameter of a computation.",
        "We differentiate between plaintext and encrypted parameters and data objects.",
        "Plaintext parameters are directly provided as their value.",
        "Encrypted parameters are provided as an offchain reference to the data.",
        "Data objects are provided as a reference to the data object account."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "plaintextBool"
          },
          {
            "name": "plaintextU8"
          },
          {
            "name": "plaintextU16"
          },
          {
            "name": "plaintextU32"
          },
          {
            "name": "plaintextU64"
          },
          {
            "name": "plaintextU128"
          },
          {
            "name": "ciphertext"
          },
          {
            "name": "arcisX25519Pubkey"
          },
          {
            "name": "arcisSignature"
          },
          {
            "name": "plaintextFloat"
          },
          {
            "name": "plaintextI8"
          },
          {
            "name": "plaintextI16"
          },
          {
            "name": "plaintextI32"
          },
          {
            "name": "plaintextI64"
          },
          {
            "name": "plaintextI128"
          },
          {
            "name": "plaintextPoint"
          }
        ]
      }
    },
    {
      "name": "priceFeedMessage",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "feedId",
            "docs": [
              "`FeedId` but avoid the type alias because of compatibility issues with Anchor's `idl-build` feature."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "price",
            "type": "i64"
          },
          {
            "name": "conf",
            "type": "u64"
          },
          {
            "name": "exponent",
            "type": "i32"
          },
          {
            "name": "publishTime",
            "docs": [
              "The timestamp of this price update in seconds"
            ],
            "type": "i64"
          },
          {
            "name": "prevPublishTime",
            "docs": [
              "The timestamp of the previous price update. This field is intended to allow users to",
              "identify the single unique price update for any moment in time:",
              "for any time t, the unique update is the one such that prev_publish_time < t <= publish_time.",
              "",
              "Note that there may not be such an update while we are migrating to the new message-sending logic,",
              "as some price updates on pythnet may not be sent to other chains (because the message-sending",
              "logic may not have triggered). We can solve this problem by making the message-sending mandatory",
              "(which we can do once publishers have migrated over).",
              "",
              "Additionally, this field may be equal to publish_time if the message is sent on a slot where",
              "where the aggregation was unsuccesful. This problem will go away once all publishers have",
              "migrated over to a recent version of pyth-agent."
            ],
            "type": "i64"
          },
          {
            "name": "emaPrice",
            "type": "i64"
          },
          {
            "name": "emaConf",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "priceUpdateV2",
      "docs": [
        "A price update account. This account is used by the Pyth Receiver program to store a verified price update from a Pyth price feed.",
        "It contains:",
        "- `write_authority`: The write authority for this account. This authority can close this account to reclaim rent or update the account to contain a different price update.",
        "- `verification_level`: The [`VerificationLevel`] of this price update. This represents how many Wormhole guardian signatures have been verified for this price update.",
        "- `price_message`: The actual price update.",
        "- `posted_slot`: The slot at which this price update was posted."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "writeAuthority",
            "type": "pubkey"
          },
          {
            "name": "verificationLevel",
            "type": {
              "defined": {
                "name": "verificationLevel"
              }
            }
          },
          {
            "name": "priceMessage",
            "type": {
              "defined": {
                "name": "priceFeedMessage"
              }
            }
          },
          {
            "name": "postedSlot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "riskLimits",
      "docs": [
        "User-chosen risk parameters, fixed at vault creation.",
        "",
        "Stored now but enforced by `execute_trade`, which arrives with the trading",
        "phases. Keeping them here means a vault's risk envelope is chosen by its",
        "owner at creation rather than supplied by whoever happens to submit a trade."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "maxTradeBps",
            "docs": [
              "Max single trade as a fraction of vault value."
            ],
            "type": "u16"
          },
          {
            "name": "maxSlippageBps",
            "docs": [
              "Max tolerated slippage on a swap."
            ],
            "type": "u16"
          },
          {
            "name": "dailyLossLimitBps",
            "docs": [
              "**STORED, NOT ENFORCED.** Nothing reads this field.",
              "",
              "It was documented as \"max cumulative realised loss per UTC day\", which",
              "this program cannot measure. Realised P&L needs a cost basis, and base",
              "tokens enter and leave outside trading — `deposit` and `withdraw` both",
              "accept either mint — so assigning basis means pricing a withdrawal,",
              "which means putting the oracle on the withdraw path. `withdraw` must",
              "keep working when Pyth, Arcium and the operator are all unavailable, so",
              "that trade is not available.",
              "",
              "Marking to market is measurable but is not loss: a NAV fall from SOL",
              "simply dropping is indistinguishable on chain from a fall caused by",
              "trading, and halting on it would disarm the vault precisely when a stop",
              "needs to fire.",
              "",
              "Left in place rather than deleted because removing it changes the",
              "account layout again. Do not describe it as protection."
            ],
            "type": "u16"
          },
          {
            "name": "cooldownSeconds",
            "docs": [
              "Minimum seconds between trades."
            ],
            "type": "u32"
          },
          {
            "name": "maxOracleStalenessSec",
            "docs": [
              "Reject oracle prices older than this."
            ],
            "type": "u32"
          },
          {
            "name": "maxConfBps",
            "docs": [
              "Reject oracle prices whose confidence/price ratio exceeds this."
            ],
            "type": "u16"
          },
          {
            "name": "maxOracleDeviationBps",
            "docs": [
              "Reject executions deviating from the oracle band by more than this."
            ],
            "type": "u16"
          },
          {
            "name": "sizeBps",
            "docs": [
              "Share of the spendable balance a triggered rule trades, in basis points.",
              "",
              "Public on purpose. It used to be the fourth field of the *encrypted*",
              "strategy, which implied a secrecy it never had: the traded amount and",
              "the vault balance are both public in the same transaction, so",
              "`size_bps = amount * 10_000 / balance` recovers it exactly from a single",
              "trade. See SECURITY.md T-38 and docs/privacy.md. Encrypting it",
              "cost MPC gates to protect nothing, and told the user it was protected."
            ],
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "setUnset",
      "docs": [
        "Utility struct to store a value that needs to be set by a certain number of participants (keys",
        "in our case). Once all participants have set the value, the value is considered set and we only",
        "store it once."
      ],
      "generics": [
        {
          "kind": "type",
          "name": "t"
        }
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "set",
            "fields": [
              {
                "generic": "t"
              }
            ]
          },
          {
            "name": "unset",
            "fields": [
              {
                "generic": "t"
              },
              {
                "vec": "bool"
              }
            ]
          }
        ]
      }
    },
    {
      "name": "signedComputationOutputs",
      "generics": [
        {
          "kind": "type",
          "name": "o"
        }
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "success",
            "fields": [
              {
                "generic": "o"
              },
              {
                "array": [
                  "u8",
                  64
                ]
              }
            ]
          },
          {
            "name": "failure"
          },
          {
            "name": "markerForIdlBuildDoNotUseThis",
            "fields": [
              {
                "generic": "o"
              }
            ]
          }
        ]
      }
    },
    {
      "name": "statusChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "vaultStatus"
              }
            }
          },
          {
            "name": "authority",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "storeStrategyV2Output",
      "docs": [
        "The output of the callback instruction. Provided as a struct with ordered fields",
        "as anchor does not support tuples and tuple structs yet."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "field0",
            "type": {
              "defined": {
                "name": "mxeEncryptedStruct",
                "generics": [
                  {
                    "kind": "const",
                    "value": "3"
                  }
                ]
              }
            }
          }
        ]
      }
    },
    {
      "name": "strategyConverted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "version",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "strategyCopied",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "leader",
            "type": "pubkey"
          },
          {
            "name": "version",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "strategyState",
      "docs": [
        "A vault's encrypted strategy.",
        "",
        "The program stores these bytes and never interprets them. It cannot: the",
        "plaintext is three integers encrypted under a secret shared between the",
        "submitter and the MXE cluster, and nothing on chain holds either half of",
        "that exchange. Storing opaque bytes is the point, not a limitation.",
        "",
        "`encryption_pubkey` is the submitter's x25519 public key. The MXE needs it",
        "to derive the same shared secret, so it is public by construction — it",
        "reveals who encrypted, never what."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "ciphertexts",
            "docs": [
              "One 32-byte ciphertext per encrypted scalar, in circuit field order."
            ],
            "type": {
              "array": [
                {
                  "array": [
                    "u8",
                    32
                  ]
                },
                3
              ]
            }
          },
          {
            "name": "nonce",
            "docs": [
              "Encryption nonce. Fresh per submission; reuse would leak."
            ],
            "type": "u128"
          },
          {
            "name": "encryptionPubkey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "version",
            "docs": [
              "Bumped on every submission of *plaintext* ciphertext by the owner.",
              "",
              "Note what binds an authorization: `mxe_version`, not this. Submitting a",
              "replacement now also zeroes `mxe_ciphertexts` and `mxe_version`, which",
              "is what actually stops the previous strategy trading — this comment used",
              "to claim that `version` did it, and nothing binds to `version`."
            ],
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "follows",
            "docs": [
              "The vault this strategy was copied from, or the default pubkey if it is",
              "the owner's own. Carved from this struct's reserve, so existing strategy",
              "accounts keep every field offset they already had.",
              "",
              "Informational: nothing in the program branches on it. It exists so a",
              "follower can see, and prove, where their rules came from."
            ],
            "type": "pubkey"
          },
          {
            "name": "reserved",
            "docs": [
              "Same rule as `VaultConfig.reserved`: carve future fields out of this,",
              "never append. Added while this struct was being resized anyway (the",
              "ciphertext array went 4 -> 3), so it costs nothing now and stops the",
              "next change stranding every strategy account."
            ],
            "type": {
              "array": [
                "u8",
                0
              ]
            }
          },
          {
            "name": "mxeCiphertexts",
            "docs": [
              "The same strategy re-encrypted to the MXE cluster.",
              "",
              "`ciphertexts` above is what the user submitted, readable by them. This is",
              "what the cluster produced from it, readable only by the cluster acting",
              "together — which is what lets evaluation run with nobody online.",
              "Zero `mxe_version` means the conversion has not happened yet."
            ],
            "type": {
              "array": [
                {
                  "array": [
                    "u8",
                    32
                  ]
                },
                3
              ]
            }
          },
          {
            "name": "mxeNonce",
            "type": "u128"
          },
          {
            "name": "mxeVersion",
            "docs": [
              "The `version` this converted copy is *for*.",
              "",
              "Set by `convert_strategy` when it queues the computation, before the",
              "ciphertext exists — so a non-zero value on its own does not mean the",
              "strategy can be evaluated. Use `is_armed()`, never this field alone."
            ],
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "strategySubmitted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "version",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "timestamp",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "timestamp",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "tradeAuthorized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "amountIn",
            "type": "u64"
          },
          {
            "name": "expiresAtSlot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "tradeExecuted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "amountIn",
            "type": "u64"
          },
          {
            "name": "amountOut",
            "docs": [
              "What the swap actually delivered into the vault."
            ],
            "type": "u64"
          },
          {
            "name": "minAmountOut",
            "docs": [
              "The oracle-derived floor it had to clear."
            ],
            "type": "u64"
          },
          {
            "name": "oraclePrice",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "tradeIntent",
      "docs": [
        "A single authorized trade, written only by a verified Arcium callback.",
        "",
        "This is the whole authorization surface for moving vault funds into a swap.",
        "It is deliberately a singleton per vault: a new decision overwrites any",
        "unconsumed one, so there is no queue to stuff and no ordering to reason about.",
        "",
        "Every field here is a constraint the executor must satisfy, not a hint. The",
        "executor is permissionless precisely because it holds no privilege — it",
        "chooses only whether and when to submit, inside a window this account defines."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "side",
            "docs": [
              "1 = BUY (quote -> base), 2 = SELL (base -> quote). 0 never lands here."
            ],
            "type": "u8"
          },
          {
            "name": "amountIn",
            "docs": [
              "Input amount in the source mint's base units."
            ],
            "type": "u64"
          },
          {
            "name": "minAmountOut",
            "docs": [
              "Floor on the output, in the destination mint's base units, as computed",
              "when the intent was minted.",
              "",
              "Recorded, but deliberately *not* what the swap is checked against.",
              "`execute_trade` re-derives the floor from a fresh oracle read and",
              "enforces that instead, so a floor computed at decision time cannot go",
              "stale between the callback and execution. This field is the audit trail",
              "of what the decision expected; the enforced number is the fresh one."
            ],
            "type": "u64"
          },
          {
            "name": "expiresAtSlot",
            "docs": [
              "Slot after which this authorization is dead."
            ],
            "type": "u64"
          },
          {
            "name": "vaultNonce",
            "docs": [
              "Must equal `VaultConfig.nonce`. Bumped on execution, which is what makes",
              "a consumed intent unreplayable even if `consumed` were somehow cleared."
            ],
            "type": "u64"
          },
          {
            "name": "strategyVersion",
            "docs": [
              "Binds the authorization to the strategy that produced it. Replacing the",
              "strategy invalidates any intent still in flight."
            ],
            "type": "u32"
          },
          {
            "name": "oraclePrice",
            "docs": [
              "The oracle price the decision was made at.",
              "",
              "`execute_trade` compares this against a fresh read and refuses an entry",
              "that would fill more than `max_oracle_deviation_bps` above it. Exits are",
              "exempt by design — see the check itself for why blocking a stop because",
              "the price fell further would be backwards."
            ],
            "type": "u64"
          },
          {
            "name": "consumed",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "utilityPubkeys",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "x25519Pubkey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "ed25519VerifyingKey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "elgamalPubkey",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "pubkeyValidityProof",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          }
        ]
      }
    },
    {
      "name": "vaultConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "docs": [
              "The only address funds can ever be withdrawn to."
            ],
            "type": "pubkey"
          },
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "quoteMint",
            "type": "pubkey"
          },
          {
            "name": "limits",
            "type": {
              "defined": {
                "name": "riskLimits"
              }
            }
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "vaultStatus"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "nonce",
            "docs": [
              "Monotonic. Bumped on every executed trade, so an old authorization can",
              "never be replayed against a vault that has moved on."
            ],
            "type": "u64"
          },
          {
            "name": "lastTradeTs",
            "docs": [
              "Unix time of the last executed trade, for `cooldown_seconds`.",
              "",
              "Zero until the first trade, which is what lets the first one through",
              "without a special case."
            ],
            "type": "i64"
          },
          {
            "name": "listed",
            "docs": [
              "Whether this vault appears in public discovery.",
              "",
              "Carved from the reserve rather than appended, so every existing vault",
              "keeps the offset of every field it already had. An account created",
              "before this field existed reads it out of zeroed reserve bytes, which",
              "decodes as `false` — the correct default. That is the reserve working as",
              "intended, and the reason it was added.",
              "",
              "Listing publishes nothing that was not already public: the vault, its",
              "balances, its limits and its trades are all readable by anyone. It only",
              "makes the vault findable, and it never exposes the encrypted strategy —",
              "no instruction can."
            ],
            "type": "bool"
          },
          {
            "name": "name",
            "docs": [
              "A display name for a listed vault. UTF-8, zero-padded, may be empty.",
              "",
              "Fixed width because Anchor accounts are fixed size. The program does not",
              "interpret it, and a client must treat it as untrusted text from a",
              "stranger — it is chosen by the vault's owner, not verified by anyone."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "maxBaseExposureBps",
            "docs": [
              "Ceiling on how much of the vault may sit in the base asset, in basis",
              "points of total value, enforced on entries only.",
              "",
              "Sits immediately before `reserved` because that is the rule. It was",
              "briefly inserted ahead of `listed`/`name` instead, which kept the struct",
              "the same total size — and shifted both of those fields four bytes, so",
              "every vault created in between would have read its listing flag out of",
              "the wrong place. Equal size is not the invariant; equal offsets are.",
              "",
              "The strategy decides *when* to buy; this decides how concentrated the",
              "vault is allowed to become. A rule like \"buy below $150\" keeps firing",
              "all the way down, so without a ceiling a falling market converts the",
              "whole vault into the falling asset — each individual trade inside its",
              "per-trade cap, and the position unbounded in aggregate. `max_trade_bps`",
              "cannot express this: it bounds one trade, not the sum of them.",
              "",
              "0 means no ceiling, which is the value existing vaults read out of",
              "zeroed reserve bytes — preserving today's behaviour exactly."
            ],
            "type": "u16"
          },
          {
            "name": "minTradeBps",
            "docs": [
              "Refuse trades below this share of the spendable balance.",
              "",
              "A dust trade costs the same transaction and swap spread as a real one",
              "and moves nothing. With a small `size_bps` on a small vault, a strategy",
              "can otherwise grind the balance away in fees while appearing to work.",
              "0 disables it, which is what existing vaults read."
            ],
            "type": "u16"
          },
          {
            "name": "reserved",
            "docs": [
              "Space for fields this struct does not have yet. Do not read or write it.",
              "",
              "Adding `last_trade_ts` made every already-created vault fail to load with",
              "`AccountDidNotDeserialize` (3003): the account was allocated at the old",
              "`INIT_SPACE` and borsh cannot fill the missing bytes. Survivable on",
              "devnet, where the stranded vaults held a test mint. Not survivable on",
              "mainnet, because `withdraw` takes `Account<'info, VaultConfig>` and would",
              "be stranded with everything else — the one path that must keep working.",
              "",
              "The rule, stated precisely, because the loose version is wrong:",
              "",
              "a new field must be **appended immediately before this reserve** and",
              "the reserve shrunk by the same number of bytes.",
              "",
              "Equal total size is necessary and *not* sufficient. `size_bps` was added",
              "to `RiskLimits`, which sits in the middle of this struct — same total",
              "size, but every field after it shifted two bytes, so existing vaults",
              "deserialized into garbage and failed with `ConstraintSeeds` (2006) on a",
              "mis-read `bump`. A quieter failure than the `AccountDidNotDeserialize`",
              "(3003) that a size change gives you, and the same outcome for funds.",
              "",
              "Borsh is positional. Preserving the byte count preserves nothing on its",
              "own; preserving the *offset of every existing field* is the requirement."
            ],
            "type": {
              "array": [
                "u8",
                25
              ]
            }
          }
        ]
      }
    },
    {
      "name": "vaultInitialized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "quoteMint",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "vaultStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "active"
          },
          {
            "name": "paused"
          },
          {
            "name": "stopped"
          }
        ]
      }
    },
    {
      "name": "verificationLevel",
      "docs": [
        "Pyth price updates are bridged to all blockchains via Wormhole.",
        "Using the price updates on another chain requires verifying the signatures of the Wormhole guardians.",
        "The usual process is to check the signatures for two thirds of the total number of guardians, but this can be cumbersome on Solana because of the transaction size limits,",
        "so we also allow for partial verification.",
        "",
        "This enum represents how much a price update has been verified:",
        "- If `Full`, we have verified the signatures for two thirds of the current guardians.",
        "- If `Partial`, only `num_signatures` guardian signatures have been checked.",
        "",
        "# Warning",
        "Using partially verified price updates is dangerous, as it lowers the threshold of guardians that need to collude to produce a malicious price update."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "partial",
            "fields": [
              {
                "name": "numSignatures",
                "type": "u8"
              }
            ]
          },
          {
            "name": "full"
          }
        ]
      }
    },
    {
      "name": "withdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
