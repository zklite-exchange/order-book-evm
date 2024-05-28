import {loadFixture, time} from "@nomicfoundation/hardhat-network-helpers";
import {OrderCloseReason, OrderSide, setUpTest, submitOrderHelper} from "./utils";
import {expect} from "chai";
import moment from "moment/moment";

describe("Blackbox testing OrderBook contract", async () => {
    it("Submit expired order should fail", async () => {
        const load = await loadFixture(setUpTest);
        const amount = load.fmtUsdc(10);
        await load.approveSpending(load.USDC, load.bob, amount);
        await expect(
            load.OrderBookContract.connect(load.bob)
                .submitOrder(OrderSide.BUY, 123, amount, moment().subtract(1, 'day').unix(), [])
        ).to.be.revertedWith("Invalid validUntil");
    });

    it("Expired order shouldn't be filled", async () => {
        // const load = await loadFixture(setUpTest);
        const load = await loadFixture(setUpTest);
        const amount = load.fmtUsdc(10);
        await load.approveSpending(load.USDC, load.bob, amount);
        const makerOrderId = await submitOrderHelper(
            load.OrderBookContract, load.bob, OrderSide.BUY,
            123, amount, load.expireAfter(1, 'day')
        );
        await time.increaseTo(moment().add(2, 'day').toDate());

        const takerAmount = load.fmtWeth(1);
        await load.approveSpending(load.WETH, load.alice, takerAmount);
        await submitOrderHelper(
            load.OrderBookContract, load.alice, OrderSide.SELL,
            123, takerAmount, load.expireAfter(7, 'day'),
            [makerOrderId], async (tx) => {
                await expect(tx).to.emit(load.OrderBookContract, "OrderClosedEvent")
                    .withArgs(makerOrderId, load.bob.address, 0, 0, 0, OrderSide.BUY, OrderCloseReason.EXPIRED);
            }
        );
    });
});