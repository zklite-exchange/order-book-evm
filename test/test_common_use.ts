import {expect} from "chai";
import {executeTestScenarios, OrderCloseReason, orderMatrix, OrderSide, TestScenarios, TimeInForce} from "./utils";
import {BigNumberish} from "ethers";
import {OrderBook} from "../typechain";
import BN from "bignumber.js";


describe("OrderBook - Blackbox testing common cases", async function () {

    orderMatrix("Submit order and cancel order should be ok", async (load, matrix) => {
        const price = load.fmtPrice(123);
        await executeTestScenarios(load, [{
            updateAllowance: [
                {from: matrix.maker, token: matrix.makerSellToken, amount: 'max'},
            ]
        }, {
            submitOrder: {
                alias: 'order1', owner: matrix.maker, side: matrix.makerSide,
                price: price, amount: matrix.makerBalance.toString()
            }
        }, {
            expectOrder: {
                alias: 'order1', owner: matrix.maker, side: matrix.makerSide, price: price,
                amount: matrix.makerBalance.toString(),
            }
        }, {
            run: async () => {
                expect(
                    await (load.OrderBookContract as OrderBook).getSpendingAmount(
                        await matrix.maker.getAddress(),
                        await matrix.makerSellToken.getAddress()
                    )
                ).eq(matrix.makerBalance.toString());
            }
        }, {
            cancelOrder: {
                alias: 'order1', signer: matrix.maker,
                expectClosed: [
                    {alias: 'order1', reason: OrderCloseReason.CANCELLED},
                ]
            }
        }, {
            expectOrder: [
                {alias: 'order1', closed: true},
            ]
        }, {
            run: async () => {
                expect(
                    await (load.OrderBookContract as OrderBook).getSpendingAmount(
                        await matrix.maker.getAddress(),
                        await matrix.makerSellToken.getAddress()
                    )
                ).eq(0);
            }
        }]);
    });

    orderMatrix("Perfect fill (100% amount)", async (load, m) => {
        const makerPrice = load.fmtPrice(1000 + Math.random() * 2000);

        let makerAmount: BigNumberish, takerAmount: BigNumberish;
        if (m.makerSide == OrderSide.BUY) {
            takerAmount = load.fmtWeth(1 + Math.random());
            makerAmount = load.mulPrice(takerAmount, makerPrice, BN.ROUND_DOWN);
        } else {
            makerAmount = load.fmtWeth(1 + Math.random());
            takerAmount = load.mulPrice(makerAmount, makerPrice, BN.ROUND_DOWN);
        }

        const feeMaker = load.calcFee(takerAmount, load.makerFeeBps);
        const feeTaker = load.calcFee(makerAmount, load.takerFeeBps);
        await executeTestScenarios(load, [{
            updateAllowance: [
                {from: m.maker, token: m.makerSellToken, amount: 'max'},
                {from: m.taker, token: m.takerSellToken, amount: 'max'},
            ]
        }, {
            submitOrder: {
                alias: 'maker1', owner: m.maker, side: m.makerSide, price: makerPrice, amount: makerAmount
            }
        }, {
            submitOrder: {
                alias: 'taker1', owner: m.taker, side: m.takerSide, price: makerPrice, amount: takerAmount,
                orderAliasesToFill: ['maker1'],
                expectFills: [{
                    makerOrderAlias: 'maker1', takerOrderAlias: 'taker1',
                    maker: m.maker, taker: m.taker, takerSide: m.takerSide,
                    executedBase: m.makerSide == OrderSide.BUY ? takerAmount : makerAmount,
                    executedQuote: m.makerSide == OrderSide.BUY ? makerAmount : takerAmount,
                    feeMaker: feeMaker,
                    feeTaker: feeTaker
                }],
                expectClosed: [{
                    alias: 'maker1', executeAmt: makerAmount, receiveAmt: takerAmount, feeAmt: feeMaker,
                    side: m.makerSide, owner: m.maker, reason: OrderCloseReason.FILLED
                }, {
                    alias: 'taker1', executeAmt: takerAmount, receiveAmt: makerAmount, feeAmt: feeTaker,
                    side: m.takerSide, owner: m.taker, reason: OrderCloseReason.FILLED
                }],
                expectBalanceChange: [{
                    token: m.makerSellToken,
                    accounts: [m.maker, m.taker, load.admin],
                    changes: [new BN(makerAmount).times(-1), new BN(makerAmount).minus(feeTaker), feeTaker]
                }, {
                    token: m.makerBuyToken,
                    accounts: [m.maker, m.taker, load.admin],
                    changes: [new BN(takerAmount).minus(feeMaker), new BN(takerAmount).times(-1), feeMaker]
                }]
            }
        }]);
    });


    orderMatrix("Partial fill", async (load, m) => {
        const makerAmount = new BN(m.makerSide == OrderSide.BUY ? load.fmtUsdc(1000) : load.fmtWeth(1));
        const makerPrice = load.fmtPrice(1000 + Math.random() * 2000);

        let makerAmountPartial: BigNumberish, takerAmount: BigNumberish;
        if (m.makerSide == OrderSide.BUY) {
            takerAmount = load.divPrice(makerAmount.div(5), makerPrice);
            makerAmountPartial = load.mulPrice(takerAmount, makerPrice, BN.ROUND_DOWN);
        } else {
            takerAmount = load.mulPrice(makerAmount.div(5), makerPrice);
            makerAmountPartial = load.divPrice(takerAmount, makerPrice, BN.ROUND_DOWN);
        }

        const takerPrice = m.makerSide == OrderSide.BUY
            ? new BN(makerPrice).minus(1).toString()
            : new BN(makerPrice).plus(1).toString();

        const feeMaker = load.calcFee(takerAmount, load.makerFeeBps);
        const feeTaker = load.calcFee(makerAmountPartial, load.takerFeeBps);
        await executeTestScenarios(load, [{
            updateAllowance: [
                {from: m.maker, token: m.makerSellToken, amount: 'max'},
                {from: m.taker, token: m.takerSellToken, amount: 'max'},
            ]
        }, {
            submitOrder: {
                alias: 'maker1', owner: m.maker, side: m.makerSide, price: makerPrice, amount: makerAmount.toString()
            }
        }, ...[1, 2, 3].map<TestScenarios[]>(i => ([{
            submitOrder: {
                alias: `taker${i}`, owner: m.taker, side: m.takerSide, price: takerPrice, amount: takerAmount,
                orderAliasesToFill: ['maker1'],
                expectFills: [{
                    makerOrderAlias: 'maker1', takerOrderAlias: `taker${i}`,
                    maker: m.maker, taker: m.taker, takerSide: m.takerSide,
                    executedBase: m.makerSide == OrderSide.BUY ? takerAmount : makerAmountPartial,
                    executedQuote: m.makerSide == OrderSide.BUY ? makerAmountPartial : takerAmount,
                    feeMaker: feeMaker,
                    feeTaker: feeTaker
                }],
                expectClosed: [{
                    alias: `taker${i}`, executeAmt: takerAmount, reason: OrderCloseReason.FILLED,
                    side: m.takerSide, feeAmt: feeTaker
                }],
                expectBalanceChange: [{
                    token: m.makerSellToken,
                    accounts: [m.maker, m.taker, load.admin],
                    changes: [new BN(makerAmountPartial).times(-1), new BN(makerAmountPartial).minus(feeTaker), feeTaker]
                }, {
                    token: m.makerBuyToken,
                    accounts: [m.maker, m.taker, load.admin],
                    changes: [new BN(takerAmount).minus(feeMaker), new BN(takerAmount).times(-1), feeMaker]
                }]
            }
        }, {
            expectOrder: {
                alias: 'maker1', unfilledAmt: makerAmount.minus(new BN(makerAmountPartial).times(i)).toString(),
                receivedAmt: new BN(takerAmount).times(i).toString()
            }
        }])).flat(), {
            submitOrder: {
                alias: 'taker4', owner: m.taker, side: m.takerSide, price: takerPrice,
                amount: new BN(takerAmount).times(5).toString(), orderAliasesToFill: ['maker1'],
                tif: TimeInForce.IOK,
                expectClosed: [{
                    alias: 'maker1', executeAmt: makerAmount.toString(), reason: OrderCloseReason.FILLED
                }, {
                    alias: 'taker4', reason: OrderCloseReason.EXPIRED_IOK
                }]
            },
        }]);
    });

    orderMatrix("Partial fill both taker and maker order", async (load, m) => {
        const price = load.fmtPrice(1);
        await load.OrderBookContract.connect(load.admin).setMinQuote(load.defaultPairId, load.fmtUsdc(10), 0);

        const makerAmount = m.makerSide == OrderSide.BUY ? load.fmtUsdc : load.fmtWeth;
        const takerAmount = m.makerSide == OrderSide.BUY ? load.fmtWeth : load.fmtUsdc;
        await executeTestScenarios(load, [{
            updateAllowance: [
                {token: m.makerSellToken, from: m.maker, amount: 'max'},
                {token: m.takerSellToken, from: m.taker, amount: 'max'},
            ]
        }, {
            submitOrder: {
                alias: 'maker1', owner: m.maker, side: m.makerSide, amount: makerAmount(15), price
            }
        }, {
            submitOrder: {
                alias: 'taker1', owner: m.taker, side: m.takerSide, amount: takerAmount(18), price,
                orderAliasesToFill: ['maker1'],
                expectNoFill: true,
                // can't fill because remaining qty will be < minExecuteQuote
            }
        }, {
            submitOrder: {
                alias: 'maker2', owner: m.maker, side: m.makerSide, amount: makerAmount(22), price
            }
        }, {
            submitOrder: {
                // maker 22, taker 21 -> fill 11 >= minExecuteQuote
                // maker remain 11 unfilled, taker remain 10 unfilled (both >= minExecuteQuote)
                alias: 'taker2', owner: m.taker, side: m.takerSide, amount: takerAmount(21), price,
                orderAliasesToFill: ['maker2'],
                expectFills: [{
                    executedQuote: load.fmtUsdc(11),
                    executedBase: load.fmtWeth(11)
                }]
            }
        }, {
            expectOrder: [{
                alias: 'maker2', unfilledAmt: makerAmount(11)
            }, {
                alias: 'taker2', unfilledAmt: takerAmount(10)
            }]
        }]);
    });
});

