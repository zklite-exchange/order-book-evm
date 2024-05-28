import {expect} from "chai";
import {loadFixture} from "@nomicfoundation/hardhat-network-helpers";
import {OrderCloseReason, OrderSide, setUpTest, submitOrderHelper} from "./utils";
import BN from "bignumber.js";
import {anyValue} from "@nomicfoundation/hardhat-chai-matchers/withArgs";


describe("Blackbox testing OrderBook contract", async () => {

    it("Normal use case: submit order and cancel order", async () => {
        const load = await loadFixture(setUpTest);
        for (let side = OrderSide.BUY; side <= OrderSide.SELL; side++) {
            const amount = side == OrderSide.BUY ? load.fmtUsdc(100) : load.fmtWeth(1);
            const price = load.fmtPrice(3000);
            const validUtil = load.expireAfter(7, 'days');
            await (side == OrderSide.BUY ? load.USDC : load.WETH)
                .connect(load.bob)
                .approve(await load.OrderBookContract.getAddress(), amount);
            const orderId = await submitOrderHelper(load.OrderBookContract, load.bob, side, price, amount, validUtil);
            console.log("orderId", orderId);

            expect(await load.OrderBookContract.getActiveOrderIds()).to.contain(orderId);
            expect(await load.OrderBookContract.getActiveOrderIdsOf(load.bob.address)).to.contain(orderId);

            let order = await load.OrderBookContract.getOrder(orderId);
            expect(order.id).eq(orderId);
            expect(order.side).eq(side);
            expect(order.price).eq(price);
            expect(order.amount).eq(amount);
            expect(order.validUntil).eq(validUtil);
            expect(order.owner).eq(load.bob.address);

            await expect(
                load.OrderBookContract.connect(load.bob).cancelOrder(orderId)
            ).to.emit(load.OrderBookContract, "OrderClosedEvent")
                .withArgs(orderId, load.bob.address, 0, 0, 0, side, OrderCloseReason.CANCELLED);

            expect(await load.OrderBookContract.getActiveOrderIds()).to.not.contain(orderId);
            expect(await load.OrderBookContract.getActiveOrderIdsOf(load.bob.address)).to.not.contain(orderId);
            order = await load.OrderBookContract.getOrder(orderId);
            // check order is zero-ed
            expect(order.id).eq(0);
            expect(order.price).eq(0);
            expect(order.amount).eq(0);
        }
    });

    it("Normal use case: Fill order 100% amount", async () => {
        const load = await loadFixture(setUpTest);
        for (let takerSide = OrderSide.BUY; takerSide <= OrderSide.SELL; takerSide++) {
            const taker = load.bob;
            const maker = load.alice;

            let takerAmount;
            let makerAmount;
            let takerPrice;
            let makerPrice;
            let makerSide;

            let takerSellToken;
            let takerBuyToken;

            if (takerSide == OrderSide.BUY) {
                makerAmount = load.fmtWeth(1);
                makerPrice = load.fmtPrice(3000); // exchange 1ETH for 3000 USDC
                makerSide = OrderSide.SELL;

                takerPrice = load.fmtPrice(4000);
                takerAmount = load.fmtUsdc(3000); // exchange 3000 USDC for at least 0.75 ETH, ends up got 1 ETH

                takerSellToken = load.USDC;
                takerBuyToken = load.WETH;

                await load.WETH.connect(maker).approve(await load.OrderBookContract.getAddress(), makerAmount);
                await load.USDC.connect(taker).approve(await load.OrderBookContract.getAddress(), takerAmount);
            } else {
                makerAmount = load.fmtUsdc(3000);
                makerPrice = load.fmtPrice(3000); // exchange 3000 USDC for 1 ETH
                makerSide = OrderSide.BUY;

                takerPrice = load.fmtPrice(2000);
                takerAmount = load.fmtWeth(1); // exchange 1 ETH for at least 2000 USDC, ends up GOT 3000 USDC

                takerSellToken = load.WETH;
                takerBuyToken = load.USDC;

                await load.WETH.connect(taker).approve(await load.OrderBookContract.getAddress(), takerAmount);
                await load.USDC.connect(maker).approve(await load.OrderBookContract.getAddress(), makerAmount);
            }

            const takerReceiveAmt = makerAmount;
            const takerFee = new BN(takerReceiveAmt).times(load.takerFeeBps).div(10000).dp(0).toString();

            const makerReceiveAmt = takerAmount;
            const makerFee = new BN(makerReceiveAmt).times(load.makerFeeBps).div(10000).dp(0).toString();

            const makerOrderId = await submitOrderHelper(
                load.OrderBookContract, maker, makerSide, makerPrice, makerAmount,
                load.expireAfter(7, 'days')
            );

            await submitOrderHelper(
                load.OrderBookContract, taker, takerSide, takerPrice, takerAmount,
                load.expireAfter(7, 'days'), [makerOrderId],
                async (tx) => {
                    await expect(tx)
                        .emit(load.OrderBookContract, "FillEvent")
                        .withArgs(
                            makerOrderId, anyValue, maker.address, taker.address,
                            takerSide == OrderSide.BUY ? takerAmount : makerAmount,
                            takerSide == OrderSide.BUY ? makerAmount : takerAmount,
                            takerFee, makerFee, takerSide
                        )
                        .and.emit(load.OrderBookContract, "OrderClosedEvent")
                        .withArgs(makerOrderId, maker.address, makerReceiveAmt, makerAmount, makerFee, makerSide, OrderCloseReason.FILLED)
                        .and.emit(load.OrderBookContract, "OrderClosedEvent")
                        .withArgs(anyValue, taker.address, takerReceiveAmt, takerAmount, takerFee, takerSide, OrderCloseReason.FILLED);

                    await expect(tx)
                        .changeTokenBalances(
                            takerSellToken,
                            [taker, maker],
                            [
                                new BN(takerAmount).times(-1).toString(),
                                new BN(makerReceiveAmt).minus(makerFee).toString()
                            ]);
                    await expect(tx)
                        .changeTokenBalances(
                            takerBuyToken,
                            [taker, maker],
                            [
                                new BN(takerReceiveAmt).minus(takerFee).toString(),
                                new BN(makerAmount).times(-1).toString()
                            ]);
                }
            );
        }
    });

    it("Normal use case: partial fill", async () => {
        const load = await loadFixture(setUpTest);
        // Alice sell 3ETH
        // Bob submit 3 order, fill 1ETH each time
        const maker = load.alice;
        const makerPrice = load.fmtPrice(3000);
        const makerAmount = load.fmtWeth(3);
        let makerUnfilledAmt = makerAmount;
        let makerReceivedAmt = "0";
        let makerFeeAmt = "0";
        await load.WETH.connect(maker).approve(await load.OrderBookContract.getAddress(), makerAmount);

        const makerOrderId = await submitOrderHelper(
            load.OrderBookContract, maker, OrderSide.SELL,
            makerPrice, makerAmount, load.expireAfter('1', 'day')
        );

        const taker = load.bob;
        const takerPrices = [5000, 4000, 3000]; // taker price doesn't matter, as long as it >= makerPrice (taker BUY)
        await load.USDC.connect(taker).approve(
            await load.OrderBookContract.getAddress(),
            new BN(makerAmount).times(makerPrice).div(load.priceDecimalPow).dp(0).toString());
        for (let i = 0; i < takerPrices.length; i++) {
            const takerPrice = load.fmtPrice(takerPrices[i]);
            const takerAmount = load.fmtUsdc(3000);

            const _makerReceiveAmt = takerAmount;
            const _makerFee = new BN(_makerReceiveAmt).times(load.makerFeeBps).div(10000).dp(0).toString();

            const takeReceiveAmt = load.fmtWeth(1); // exchange 3000 USDC for 1 ETH, because makerPrice = 3000
            const takerFee = new BN(takeReceiveAmt).times(load.takerFeeBps).div(10000).dp(0).toString();

            await submitOrderHelper(
                load.OrderBookContract, taker, OrderSide.BUY,
                takerPrice, takerAmount, load.expireAfter(1, 'day'),
                [makerOrderId], async (tx) => {
                    await expect(tx)
                        .emit(load.OrderBookContract, "FillEvent")
                        .withArgs(
                            makerOrderId, anyValue, maker.address, taker.address,
                            takerAmount, takeReceiveAmt, takerFee, _makerFee, OrderSide.BUY
                        )
                        .and.emit(load.OrderBookContract, "OrderClosedEvent")
                        .withArgs(anyValue, taker.address, takeReceiveAmt, takerAmount, takerFee, OrderSide.BUY, OrderCloseReason.FILLED);

                    await expect(tx)
                        .changeTokenBalances(
                            load.USDC,
                            [taker, maker],
                            [
                                new BN(takerAmount).times(-1).toString(),
                                new BN(_makerReceiveAmt).minus(_makerFee).toString()
                            ]);
                    await expect(tx)
                        .changeTokenBalances(
                            load.WETH,
                            [taker, maker],
                            [
                                new BN(takeReceiveAmt).minus(takerFee).toString(),
                                new BN(takeReceiveAmt).times(-1).toString()
                            ]);
                }
            );

            makerUnfilledAmt = new BN(makerUnfilledAmt).minus(takeReceiveAmt).toString();
            makerReceivedAmt = new BN(makerReceivedAmt).plus(_makerReceiveAmt).toString();
            makerFeeAmt = new BN(makerFeeAmt).plus(_makerFee).toString();
            const makerOrder = await load.OrderBookContract.getOrder(makerOrderId);
            if (i == takerPrices.length - 1) {
                // makerOrder zero-ed as it filled
                expect(makerOrder.id).eq(0);
            } else {
                expect(makerOrder.unfilledAmt).eq(makerUnfilledAmt);
                expect(makerOrder.receivedAmt).eq(makerReceivedAmt);
                expect(makerOrder.feeAmt).eq(makerFeeAmt);
            }
        }
    });


    it("Normal use case: partial fill 2", async () => {
        const load = await loadFixture(setUpTest);
        // Alice buy 3ETH
        // Bob submit 3 order, fill 1ETH each time
        const maker = load.alice;
        const makerPrice = load.fmtPrice(3000);
        const makerAmount = load.fmtUsdc(9000);
        let makerUnfilledAmt = makerAmount;
        let makerReceivedAmt = "0";
        let makerFeeAmt = "0";
        await load.USDC.connect(maker).approve(await load.OrderBookContract.getAddress(), makerAmount);

        const makerOrderId = await submitOrderHelper(
            load.OrderBookContract, maker, OrderSide.BUY,
            makerPrice, makerAmount, load.expireAfter('1', 'day')
        );

        const taker = load.bob;
        const takerPrices = [1000, 2000, 3000]; // taker price doesn't matter, as long as it <= makerPrice (taker SELL)
        await load.WETH.connect(taker).approve(
            await load.OrderBookContract.getAddress(),
            new BN(makerAmount).div(makerPrice).times(load.priceDecimalPow).dp(0).toString());
        for (let i = 0; i < takerPrices.length; i++) {
            const takerPrice = load.fmtPrice(takerPrices[i]);
            const takerAmount = load.fmtWeth(1);

            const _makerReceiveAmt = takerAmount;
            const _makerFee = new BN(_makerReceiveAmt).times(load.makerFeeBps).div(10000).dp(0).toString();

            const takeReceiveAmt = load.fmtUsdc(3000); // exchange 1 ETH for 3000 USDC, because makerPrice = 3000
            const takerFee = new BN(takeReceiveAmt).times(load.takerFeeBps).div(10000).dp(0).toString();

            await submitOrderHelper(
                load.OrderBookContract, taker, OrderSide.SELL,
                takerPrice, takerAmount, load.expireAfter(1, 'day'),
                [makerOrderId], async (tx) => {
                    await expect(tx)
                        .emit(load.OrderBookContract, "FillEvent")
                        .withArgs(
                            makerOrderId, anyValue, maker.address, taker.address,
                            takeReceiveAmt, takerAmount, takerFee, _makerFee, OrderSide.SELL
                        )
                        .and.emit(load.OrderBookContract, "OrderClosedEvent")
                        .withArgs(anyValue, taker.address, takeReceiveAmt, takerAmount, takerFee, OrderSide.SELL, OrderCloseReason.FILLED);

                    await expect(tx)
                        .changeTokenBalances(
                            load.USDC,
                            [taker, maker],
                            [
                                new BN(takeReceiveAmt).minus(takerFee).toString(),
                                new BN(takeReceiveAmt).times(-1).toString()
                            ]);
                    await expect(tx)
                        .changeTokenBalances(
                            load.WETH,
                            [taker, maker],
                            [
                                new BN(_makerReceiveAmt).times(-1).toString(),
                                new BN(_makerReceiveAmt).minus(_makerFee).toString()
                            ]);
                }
            );

            makerUnfilledAmt = new BN(makerUnfilledAmt).minus(takeReceiveAmt).toString();
            makerReceivedAmt = new BN(makerReceivedAmt).plus(_makerReceiveAmt).toString();
            makerFeeAmt = new BN(makerFeeAmt).plus(_makerFee).toString();
            const makerOrder = await load.OrderBookContract.getOrder(makerOrderId);
            if (i == takerPrices.length - 1) {
                // makerOrder zero-ed as it filled
                expect(makerOrder.id).eq(0);
            } else {
                expect(makerOrder.unfilledAmt).eq(makerUnfilledAmt);
                expect(makerOrder.receivedAmt).eq(makerReceivedAmt);
                expect(makerOrder.feeAmt).eq(makerFeeAmt);
            }
        }
    });

    it("Normal use case: partial fill 3 - unfilled amount >= minQuote", async () => {
        const load = await loadFixture(setUpTest);
        const price = load.fmtPrice(1); // price 1:1
        const minQuote = load.fmtUsdc(10);
        await load.OrderBookContract.connect(load.alice).setMinQuote(minQuote);

        const cases = [{
            makerSide: OrderSide.BUY, makerAmount: load.fmtUsdc(15),
            takerSide: OrderSide.SELL, takerAmount: load.fmtWeth(10),
            fill: null // can't fill
        }, {
            makerSide: OrderSide.BUY, makerAmount: load.fmtUsdc(15),
            takerSide: OrderSide.SELL, takerAmount: load.fmtWeth(20),
            fill: null // can't fill
        }, {
            makerSide: OrderSide.BUY, makerAmount: load.fmtUsdc(20),
            takerSide: OrderSide.SELL, takerAmount: load.fmtWeth(25),
            fill: {
                base: load.fmtWeth(10),
                quote: load.fmtUsdc(10)
            }
        }, {
            makerSide: OrderSide.SELL, makerAmount: load.fmtWeth(15),
            takerSide: OrderSide.BUY, takerAmount: load.fmtUsdc(10),
            fill: null // can't fill
        }, {
            makerSide: OrderSide.SELL, makerAmount: load.fmtWeth(15),
            takerSide: OrderSide.BUY, takerAmount: load.fmtUsdc(20),
            fill: null // can't fill
        }, {
            makerSide: OrderSide.SELL, makerAmount: load.fmtWeth(20),
            takerSide: OrderSide.BUY, takerAmount: load.fmtUsdc(21),
            fill: {
                base: load.fmtWeth(10),
                quote: load.fmtUsdc(10)
            }
        }];

        const maker = load.bob;
        const taker = load.alice;
        await load.approveSpending(load.USDC, maker, await load.USDC.balanceOf(maker.address));
        await load.approveSpending(load.WETH, maker, await load.WETH.balanceOf(maker.address));
        await load.approveSpending(load.USDC, taker, await load.USDC.balanceOf(taker.address));
        await load.approveSpending(load.WETH, taker, await load.WETH.balanceOf(taker.address));

        for (let i = 0; i < cases.length; i++) {
            const testCase = cases[i];
            const makerOrderId = await submitOrderHelper(
                load.OrderBookContract, maker, testCase.makerSide, price,
                testCase.makerAmount
            );
            await submitOrderHelper(
                load.OrderBookContract, taker, testCase.takerSide, price,
                testCase.takerAmount, undefined,
                [makerOrderId], async (tx) => {
                    if (testCase.fill) {
                        await expect(tx).to.emit(load.OrderBookContract, "FillEvent")
                            .withArgs(
                                makerOrderId, anyValue, maker.address, taker.address,
                                testCase.fill.quote, testCase.fill.base, anyValue, anyValue, testCase.takerSide);
                        expect((await load.OrderBookContract.getOrder(makerOrderId)).unfilledAmt)
                            .eq(new BN(testCase.makerAmount)
                                .minus(testCase.makerSide == OrderSide.BUY ? testCase.fill.quote : testCase.fill.base)
                            );
                    } else {
                        await expect(tx).to.not.emit(load.OrderBookContract, "FillEvent");
                    }
                }
            );
        }
    });

    it("Normal use case: fill multiple order at once", async () => {
        // alice submit 3 sell order, sell 1 ETH each
        const load = await loadFixture(setUpTest);
        const maker = load.alice;
        const makerAmount = load.fmtWeth(1);
        await load.WETH.connect(maker).approve(await load.OrderBookContract.getAddress(), load.fmtWeth(3));
        const makerPrices = [3000, 4000, 5000];
        const makerOrderIds: bigint[] = [123n, 456n]; // 123, 456 are invalid orderIds, the contract should ignore them
        for (let i = 0; i < makerPrices.length; i++) {
            const makerPrice = load.fmtPrice(makerPrices[i]);
            const makerOrderId = await submitOrderHelper(
                load.OrderBookContract, maker, OrderSide.SELL,
                makerPrice, makerAmount, load.expireAfter('1', 'day')
            );
            makerOrderIds.push(makerOrderId);
        }

        // bob submit 1 BUY order, fill all 3 order above
        const taker = load.bob;
        const takerAmount = load.fmtUsdc(3000 + 4000 + 5000);
        const takerPrice = load.fmtPrice(5000);
        await load.USDC.connect(taker).approve(await load.OrderBookContract.getAddress(), takerAmount);
        await submitOrderHelper(
            load.OrderBookContract, taker, OrderSide.BUY,
            takerPrice, takerAmount, load.expireAfter(1, 'day'),
            makerOrderIds, async (tx) => {
                for (let i = 0; i < makerPrices.length; i++) {
                    await expect(tx)
                        .emit(load.OrderBookContract, "FillEvent")
                        .withArgs(
                            makerOrderIds[i + 2], anyValue, maker.address, taker.address,
                            load.fmtUsdc(makerPrices[i]), makerAmount, anyValue, anyValue, OrderSide.BUY
                        )
                        .and.emit(load.OrderBookContract, "OrderClosedEvent")
                        .withArgs(makerOrderIds[i + 2], maker.address, anyValue, anyValue, anyValue, OrderSide.SELL, OrderCloseReason.FILLED);
                }
                await expect(tx)
                    .changeTokenBalances(
                        load.USDC,
                        [taker, maker],
                        [
                            new BN(takerAmount).times(-1).toString(),
                            new BN(takerAmount).minus(new BN(takerAmount).times(load.makerFeeBps).div(10000)).toString()
                        ]);

                await expect(tx)
                    .changeTokenBalances(
                        load.WETH,
                        [taker, maker],
                        [
                            new BN(makerAmount).times(3).minus(new BN(makerAmount).times(load.takerFeeBps).times(3).div(10000)).toString(),
                            new BN(makerAmount).times(-3).toString()
                        ]);
            }
        );
    });
});